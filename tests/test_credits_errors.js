"use strict";
/**
 * E2E test for CREDIT VISIBILITY + ERROR SURFACING.
 *
 * Part A (credits): a mock Gumloop credit endpoint whose payload shape is varied
 * between requests proves /api/credits normalizes used/limit/remaining and the
 * `exhausted` flag across several real-world key namings.
 *
 * Part B (errors): a send whose upstream WS rejects with an error frame proves
 * the failure is captured in the ring buffer and served from /api/errors (with
 * the credit flag set), and that /api/errors/clear empties it.
 */
const http = require("http");
const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const path = require("path");

const MOCK_PORT = 4730;
const SRV_PORT = 4731;
const ROOT = path.join(__dirname, "..");

let creditPayload = {}; // mutated per phase
let wsErrorMessage = "insufficient credits for this run";

const j = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const mock = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (req.method === "POST" && p === "/v1/token")
    return j(res, 200, { id_token: "mock_id", refresh_token: "mock_rt", user_id: "uid_mock", expires_in: "3600" });
  if (p === "/get_subscription_tier_credit_limit") return j(res, 200, creditPayload);
  if (/^\/gummie_interactions\//.test(p))
    return j(res, 200, { interaction: { name: "Conv", messages: [] } });
  return j(res, 200, {});
});
const wss = new WebSocketServer({ server: mock, path: "/ws/gummies" });
wss.on("connection", (ws) => {
  ws.on("message", () => { try { ws.send(JSON.stringify({ type: "error", errorMessage: wsErrorMessage })); } catch {} });
});

function getJSON(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: SRV_PORT, path: p }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: b }); } });
    }).on("error", reject);
  });
}
function postJSON(p, obj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(obj || {});
    const req = http.request({ host: "127.0.0.1", port: SRV_PORT, path: p, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: b }); } });
    });
    req.on("error", reject); req.write(data); req.end();
  });
}
// Drain an SSE send so the server runs finishUp and records the error.
function sendStream(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: SRV_PORT, path: "/api/send/stream", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      res.on("data", () => {}); res.on("end", () => resolve());
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
      CREDIT_CACHE_MS: "0", // disable caching so per-phase payloads are read fresh
      PD_STATE_FILE: path.join(__dirname, ".test-state-credits.json"), DATABASE_URL: "" },
    stdio: ["ignore", "pipe", "pipe"] });
  srv.stderr.on("data", () => {});
  await waitStatus();

  console.log("\nPART A \u2014 credit normalization across shapes");
  creditPayload = { credits_used: 100, credit_limit: 1000, subscription_tier: "Pro" };
  let c = (await getJSON("/api/credits")).body;
  ok(c.used === 100 && c.limit === 1000, "used/limit parsed (used=" + c.used + ", limit=" + c.limit + ")");
  ok(c.remaining === 900, "remaining derived = 900 (got " + c.remaining + ")");
  ok(c.exhausted === false, "not exhausted when remaining > 0");
  ok(c.tier === "Pro", "tier surfaced (" + c.tier + ")");

  creditPayload = { used_credits: 1000, credit_limit: 1000 };
  c = (await getJSON("/api/credits")).body;
  ok(c.remaining === 0 && c.exhausted === true, "exhausted=true when used == limit (remaining=" + c.remaining + ")");

  creditPayload = { credits_remaining: 5, credit_limit: 200 };
  c = (await getJSON("/api/credits")).body;
  ok(c.remaining === 5 && c.used === 195 && c.exhausted === false, "remaining-only shape derives used=195 (got used=" + c.used + ")");

  creditPayload = { data: { credits: { used: 40, limit: 50 } } };
  c = (await getJSON("/api/credits")).body;
  ok(c.used === 40 && c.limit === 50 && c.remaining === 10, "nested shape parsed (used=" + c.used + ", remaining=" + c.remaining + ")");

  console.log("\nPART B \u2014 Gumloop error surfacing");
  await postJSON("/api/errors/clear", {});
  let e0 = (await getJSON("/api/errors")).body;
  ok(e0.count === 0, "error log starts empty after clear");

  await sendStream({ message: "do the task", turnstile_token: "na", hcaptcha_token: "h" });
  await sleep(300);
  let e1 = (await getJSON("/api/errors")).body;
  ok(e1.count >= 1, "an upstream WS error was captured (count=" + e1.count + ")");
  const top = (e1.errors || [])[0] || {};
  ok(top.source === "send", "captured error tagged source 'send' (got '" + top.source + "')");
  ok(/insufficient credits/.test(top.message || ""), "captured error carries the upstream message");
  ok(top.credit === true, "credit-related error flagged for the UI");

  const cl = await postJSON("/api/errors/clear", {});
  ok(cl.body && cl.body.ok === true, "clear endpoint responds ok");
  let e2 = (await getJSON("/api/errors")).body;
  ok(e2.count === 0, "error log empty after clear");

  console.log("\n" + (failures === 0 ? "ALL TESTS PASSED" : failures + " ASSERTION(S) FAILED"));
  try { srv.kill(); } catch {}
  try { require("fs").unlinkSync(path.join(__dirname, ".test-state-credits.json")); } catch {}
  mock.close(); wss.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("TEST ERROR", e); process.exit(1); });
