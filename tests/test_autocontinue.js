"use strict";
/**
 * E2E test for the AUTO-CONTINUE feature.
 *
 * Part A (server): proves the AUTONOMOUS-MODE directive is injected on
 * autocontinue sends and that the `done` SSE event reports `complete` (sentinel
 * present) and `pending` (ask_human_input present) correctly.
 *
 * Part B (browser): stubs the invisible captcha + blocks external captcha
 * scripts, enables Auto-continue, sends ONE message, and proves the client
 * auto-resends "continue" with NO human action until the agent emits
 * ⟦TASK_COMPLETE⟧, i.e. the user never types "continue".
 */
const http = require("http");
const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const path = require("path");

const MOCK_PORT = 4710;
const SRV_PORT = 4711;
const ROOT = path.join(__dirname, "..");

const SENTINEL = "\u27e6TASK_COMPLETE\u27e7";
let received = []; // every WS message content the agent sent upstream

// ---- mock Gumloop (token + REST + WS), with per-turn REST behaviour ----
function lastContent() { return received.length ? received[received.length - 1] : ""; }
function partsForLast() {
  const c = lastContent();
  if (/ASK_PENDING_TEST\s*$/.test(c.trim()))
    return [
      { type: "reasoning", reasoning: "I need a decision from the user." },
      { type: "tool_invocation", toolName: "ask_human_input", toolCaption: "Ask which option",
        result: { args: { questions: [{ title: "Pick one", prompt: "A or B?" }] } } },
    ];
  if (c.trim().endsWith("continue"))
    return [{ type: "text", text: "All phases delivered and verified.\n" + SENTINEL }];
  return [{ type: "text", text: "Finished phase 1; more work remains." }];
}
const j = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const mock = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (req.method === "POST" && p === "/v1/token")
    return j(res, 200, { id_token: "mock_id", refresh_token: "mock_rt", user_id: "uid_mock", expires_in: "3600" });
  if (p === "/gummies" && req.method === "GET") return j(res, 200, [{ gummie_id: "agent_test_1", name: "PD mock" }]);
  if (/^\/gummies\/[^/]+\/chat/.test(p)) return j(res, 200, { data: [] });
  if (/^\/gummie_interactions\//.test(p))
    return j(res, 200, { interaction: { name: "Conv", messages: [{ role: "assistant", models: ["claude-opus-4-8"], parts: partsForLast() }] } });
  if (p === "/allowed_gummies_models")
    return j(res, 200, { model_groups: [{ groupLabel: "Anthropic", options: [{ label: "Claude 4.8 Opus", value: "gummies_smartest" }] }] });
  return j(res, 200, {});
});
const wss = new WebSocketServer({ server: mock, path: "/ws/gummies" });
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let m = null; try { m = JSON.parse(raw.toString()); } catch {}
    if (!m || m.type !== "start") return;
    try { received.push(m.payload.context.message.content || ""); } catch { received.push(""); }
    const frames = [
      { type: "interaction-ready" }, { type: "step-start", modelId: "claude-opus-4-8" },
      { type: "text", text: "working..." }, { type: "finish" },
    ];
    let i = 0; const tick = () => { if (i >= frames.length) return; try { ws.send(JSON.stringify(frames[i++])); } catch {} if (i < frames.length) setTimeout(tick, 60); }; tick();
  });
});

// ---- SSE helper: POST /api/send/stream and resolve the `done` event ----
function sendStream(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: SRV_PORT, path: "/api/send/stream", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let buf = "", done = null, start = null;
      res.on("data", (ch) => {
        buf += ch.toString();
        let idx; while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          let ev = "message", d = "";
          chunk.split("\n").forEach((l) => { if (l.startsWith("event:")) ev = l.slice(6).trim(); else if (l.startsWith("data:")) d += l.slice(5).trim(); });
          if (ev === "start") { try { start = JSON.parse(d); } catch {} }
          if (ev === "done") { try { done = JSON.parse(d); } catch {} }
        }
      });
      res.on("end", () => resolve({ done, start }));
    });
    req.on("error", reject); req.write(data); req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitStatus() { for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${SRV_PORT}/api/status`); if (r.ok) return; } catch {} await sleep(200); } throw new Error("server did not start"); }

(async () => {
  let srv, failures = 0;
  const ok = (c, m) => { console.log((c ? "  \u2713 " : "  \u2717 ") + m); if (!c) failures++; };
  await new Promise((r) => mock.listen(MOCK_PORT, r));
  console.log("mock up on", MOCK_PORT);

  srv = spawn(process.execPath, [path.join(ROOT, "server", "server.js")], {
    env: { ...process.env, PORT: String(SRV_PORT),
      GUMLOOP_REFRESH_TOKEN: "mock_rt", GUMLOOP_GUMMIE_ID: "agent_test_1",
      GUMLOOP_API_URL: `http://127.0.0.1:${MOCK_PORT}`, GUMLOOP_WS_URL: `ws://127.0.0.1:${MOCK_PORT}/ws/gummies`,
      FIREBASE_TOKEN_URL: `http://127.0.0.1:${MOCK_PORT}/v1/token`,
      PD_STATE_FILE: path.join(__dirname, ".test-state.json"), DATABASE_URL: "" },
    stdio: ["ignore", "pipe", "pipe"] });
  srv.stderr.on("data", () => {});
  await waitStatus();

  console.log("\nPART A \u2014 server: directive injection + done flags");
  // Turn 1 (new conversation, autocontinue on): incomplete, no pending.
  const t1 = await sendStream({ message: "Do the whole multi-phase task.", turnstile_token: "na", hcaptcha_token: "h", autocontinue: true });
  const iid = t1.start && t1.start.interaction_id;
  ok(t1.done && t1.done.complete === false, "turn 1 not marked complete (no sentinel)");
  ok(t1.done && t1.done.pending === false, "turn 1 not marked pending");
  ok(/^\[AUTONOMOUS MODE\]/.test(received[0] || ""), "AUTONOMOUS MODE directive injected into turn 1");

  // Turn 2: auto "continue" -> mock returns the completion sentinel.
  const t2 = await sendStream({ interaction_id: iid, message: "continue", turnstile_token: "na", hcaptcha_token: "h", autocontinue: true });
  ok(received[1] && received[1].trim().endsWith("continue"), "turn 2 outgoing ends with 'continue'");
  ok(t2.done && t2.done.complete === true, "turn 2 marked complete (sentinel detected)");
  ok(t2.done && /TASK_COMPLETE/.test(t2.done.reply || ""), "sentinel present in reply");

  // Pending: ask_human_input -> done.pending true.
  const tp = await sendStream({ interaction_id: iid, message: "ASK_PENDING_TEST", turnstile_token: "na", hcaptcha_token: "h", autocontinue: true });
  ok(tp.done && tp.done.pending === true, "ask_human_input turn marked pending");
  ok(tp.done && tp.done.complete === false, "pending turn not marked complete");

  // PART B, browser loop
  console.log("\nPART B \u2014 browser: auto-continue loop (no manual 'continue')");
  received.length = 0;
  let browserOk = true, pw;
  try { pw = require(path.join(ROOT, "node_modules", "playwright")); }
  catch { try { pw = require("playwright"); } catch { browserOk = false; } }
  if (!browserOk) { console.log("  ! playwright unavailable \u2014 skipping browser test"); }
  else {
    const exe = process.env.CHROMIUM_PATH || "/usr/bin/chromium" ;
    let browser;
    try { browser = await pw.chromium.launch({ executablePath: require("fs").existsSync(exe) ? exe : undefined, args: ["--no-sandbox"] }); }
    catch (e) { browser = await pw.chromium.launch({ args: ["--no-sandbox"] }); }
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // Block the real captcha scripts so our stubs survive.
    await page.route(/hcaptcha\.com|challenges\.cloudflare\.com/, (r) => r.abort());
    await page.addInitScript(() => {
      localStorage.setItem("pd_autocontinue", "1");
      localStorage.setItem("pd_autocap", "5");
      let hcb = null;
      window.hcaptcha = { render: (el, o) => { hcb = o.callback; return 1; },
        execute: () => { setTimeout(() => hcb && hcb("mocktok"), 5); },
        reset: () => {}, getResponse: () => "mocktok" };
      window.turnstile = { render: () => 2, execute: () => {}, reset: () => {}, getResponse: () => "tstok" };
    });
    const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    await page.goto(`http://127.0.0.1:${SRV_PORT}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.SITEKEYS && document.getElementById("autoToggle"));
    ok(await page.$eval("#autoToggle", (e) => e.checked), "Auto-continue toggle restored ON from localStorage");
    await page.fill("#input", "Do the whole multi-phase task.");
    await page.click("#send");
    // Wait until the loop stops on the sentinel ("Task complete" note).
    await page.waitForFunction(() => { const n = document.getElementById("autoNote"); return n && /Task complete/.test(n.textContent); }, { timeout: 20000 }).catch(() => {});
    const note = await page.$eval("#autoNote", (e) => e.textContent).catch(() => "");
    const userMsgs = await page.$$eval(".msg.user", (els) => els.length);
    const autoMsgs = await page.$$eval(".msg.user.auto-msg", (els) => els.length);
    ok(received.length >= 2, "client auto-sent 'continue' (>=2 turns) with no human typing \u2014 got " + received.length);
    ok(received.some((c) => c.trim().endsWith("continue")), "an auto 'continue' reached the agent");
    ok(/Task complete/.test(note), "loop stopped with 'Task complete' note");
    ok(userMsgs >= 2 && autoMsgs >= 1, "auto 'continue' rendered as an auto-msg bubble (user=" + userMsgs + ", auto=" + autoMsgs + ")");
    ok(errs.length === 0, "zero page errors" + (errs.length ? ": " + errs.join("; ") : ""));
    await browser.close();
  }

  console.log("\n" + (failures === 0 ? "ALL TESTS PASSED" : failures + " ASSERTION(S) FAILED"));
  try { srv.kill(); } catch {}
  try { require("fs").unlinkSync(path.join(__dirname, ".test-state.json")); } catch {}
  mock.close(); wss.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("TEST ERROR", e); process.exit(1); });
