"use strict";
/**
 * E2E test for the REAL streaming-frame protocol.
 *
 * Derived from a captured production WebSocket session (HAR). Gumloop streams a
 * turn as:
 *   interaction-ready -> step-start -> context-usage -> text-start ->
 *   text-delta(delta) ... -> text-end -> credit-update -> finish
 * and multi-step turns emit a `step-finish` between steps that must NOT end the
 * turn. The other suites only stream the simplified {type:"text"} shape, so two
 * production behaviors were previously untested:
 *   (1) text accumulation from `text-delta` frames (the `delta` field), and
 *   (2) the turn continuing past `step-finish`, ending only on `finish`.
 *
 * This drives the server over the real sequence with REST reconciliation
 * returning NO messages, forcing the streamed-text fallback so the assertions
 * observe exactly what the delta pipeline produced.
 */
const http = require("http");
const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const path = require("path");

const MOCK_PORT = 4760;
const SRV_PORT = 4761;
const ROOT = path.join(__dirname, "..");

// What the WS should stream on the next turn (set per scenario).
let frameScript = [];

const j = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const mock = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (req.method === "POST" && p === "/v1/token")
    return j(res, 200, { id_token: "mock_id", refresh_token: "mock_rt", user_id: "uid_mock", expires_in: "3600" });
  // Reconciliation returns NO assistant messages, so the server falls back to
  // the text it accumulated from the streamed delta frames.
  if (/^\/gummie_interactions\//.test(p))
    return j(res, 200, { interaction: { name: "Streaming protocol", messages: [] } });
  return j(res, 200, {});
});

const wss = new WebSocketServer({ server: mock, path: "/ws/gummies" });
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let m = null; try { m = JSON.parse(raw.toString()); } catch {}
    if (!m || m.type !== "start") return;
    let i = 0;
    const tick = () => {
      if (i >= frameScript.length) return;
      try { ws.send(JSON.stringify(frameScript[i++])); } catch {}
      if (i < frameScript.length) setTimeout(tick, 20);
    };
    tick();
  });
});

// SSE client that captures the forwarded frame types and the final `done` event.
function sendStream(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port: SRV_PORT, path: "/api/send/stream", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let buf = "", start = null, done = null, error = null; const frameTypes = [];
      res.on("data", (ch) => { buf += ch.toString();
        let idx; while ((idx = buf.indexOf("\n\n")) !== -1) { const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          let ev = "message", d = ""; chunk.split("\n").forEach((l) => { if (l.startsWith("event:")) ev = l.slice(6).trim(); else if (l.startsWith("data:")) d += l.slice(5).trim(); });
          if (!d) continue;
          let parsed = null; try { parsed = JSON.parse(d); } catch {}
          if (ev === "start") start = parsed;
          else if (ev === "frame" && parsed && parsed.type) frameTypes.push(parsed.type);
          else if (ev === "done") done = parsed;
          else if (ev === "error") error = parsed;
        } });
      res.on("end", () => resolve({ start, done, error, frameTypes }));
    });
    r.on("error", reject); r.write(data); r.end();
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
      PD_STATE_FILE: path.join(__dirname, ".test-state-stream.json"), DATABASE_URL: "" },
    stdio: ["ignore", "pipe", "pipe"] });
  srv.stderr.on("data", () => {});
  await waitStatus();

  // ---- PART A: real text-delta sequence spanning a step-finish boundary ----
  console.log("\nPART A \u2014 production frame protocol (text-delta + step-finish)");
  frameScript = [
    { type: "interaction-ready", interaction_id: "int_stream", stream_cursor: "c:0" },
    { type: "step-start", id: "step-1", modelId: "claude-opus-4-8" },
    { type: "context-usage", conversationTokens: 7653, contextWindow: 200000 },
    { type: "text-start", id: "msg-1" },
    { type: "text-delta", id: "msg-1", delta: "Hello " },
    { type: "text-delta", id: "msg-1", delta: "from " },
    { type: "tool_invocation", toolName: "web_search", toolCaption: "Look up sources", toolCallState: "running" },
    { type: "tool_invocation", toolName: "web_search", toolCaption: "Look up sources", toolCallState: "completed" },
    { type: "step-finish", id: "step-1" },                 // must NOT end the turn
    { type: "step-start", id: "step-2", modelId: "claude-opus-4-8" },
    { type: "text-delta", id: "msg-1", delta: "the agent." },
    { type: "text-end", id: "msg-1" },
    { type: "credit-update", credit_cost: 3.0 },
    { type: "finish", finishReason: "end_turn", usage: { total_tokens: 41161 } },
  ];
  const a = await sendStream({ message: "stream please", turnstile_token: "na", hcaptcha_token: "h" });
  ok(a.done != null, "turn completed (server terminated on the `finish` frame)");
  ok(a.error == null, "no error surfaced for a clean streamed turn");
  ok(a.done && a.done.reply === "Hello from the agent.",
    "text accumulated from text-delta `delta` frames across a step-finish (got: " + (a.done && JSON.stringify(a.done.reply)) + ")");
  ok(a.frameTypes.includes("text-delta"), "text-delta frames were forwarded to the browser as SSE");
  ok(a.frameTypes.includes("step-finish"), "step-finish was forwarded (and did not end the turn early)");
  ok(a.done && a.done.complete === false, "no completion token -> complete=false");
  ok(a.done && a.done.pending === false, "no ask_human_input part -> pending=false");

  // ---- PART B: completion token in the streamed text is detected ----
  console.log("\nPART B \u2014 completion-token detection from streamed text");
  frameScript = [
    { type: "interaction-ready", interaction_id: "int_stream2" },
    { type: "step-start", id: "s1", modelId: "claude-opus-4-8" },
    { type: "text-start", id: "m2" },
    { type: "text-delta", id: "m2", delta: "All phases delivered and verified.\n" },
    { type: "text-delta", id: "m2", delta: "\u27e6TASK_COMPLETE\u27e7" },
    { type: "text-end", id: "m2" },
    { type: "finish", finishReason: "end_turn" },
  ];
  const b = await sendStream({ message: "finish it", turnstile_token: "na", hcaptcha_token: "h" });
  ok(b.done && b.done.complete === true, "completion token in streamed text -> complete=true");
  ok(b.done && /All phases delivered/.test(b.done.reply || ""), "streamed reply preserved alongside the token");

  console.log("\n" + (failures === 0 ? "ALL TESTS PASSED" : failures + " ASSERTION(S) FAILED"));
  try { srv.kill(); } catch {}
  try { require("fs").unlinkSync(path.join(__dirname, ".test-state-stream.json")); } catch {}
  mock.close(); wss.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("TEST ERROR", e); process.exit(1); });
