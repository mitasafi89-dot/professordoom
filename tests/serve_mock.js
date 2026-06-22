"use strict";
// Boots the mock Gumloop + the real ProfessorDoom server wired to it, and
// exposes GET /received on the mock so an external (Python) browser test can
// assert how many turns the client auto-sent. Stays alive until killed.
const http = require("http");
const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const path = require("path");

const MOCK_PORT = 4720, SRV_PORT = 4721, ROOT = path.join(__dirname, "..");
const SENTINEL = "\u27e6TASK_COMPLETE\u27e7";
let received = [];
function lastContent() { return received.length ? received[received.length - 1] : ""; }
function partsForLast() {
  const c = lastContent();
  if (c.trim().endsWith("continue")) return [{ type: "text", text: "All phases delivered.\n" + SENTINEL }];
  return [{ type: "text", text: "Finished phase 1; more work remains." }];
}
const j = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(obj)); };
const mock = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/received") return j(res, 200, { received });
  if (req.method === "POST" && p === "/v1/token") return j(res, 200, { id_token: "mock_id", refresh_token: "mock_rt", user_id: "uid_mock", expires_in: "3600" });
  if (p === "/gummies" && req.method === "GET") return j(res, 200, [{ gummie_id: "agent_test_1", name: "PD mock" }]);
  if (/^\/gummies\/[^/]+\/chat/.test(p)) return j(res, 200, { data: [] });
  if (/^\/gummie_interactions\//.test(p)) return j(res, 200, { interaction: { name: "Conv", messages: [{ role: "assistant", models: ["claude-opus-4-8"], parts: partsForLast() }] } });
  if (p === "/allowed_gummies_models") return j(res, 200, { model_groups: [{ groupLabel: "Anthropic", options: [{ label: "Claude 4.8 Opus", value: "gummies_smartest" }] }] });
  return j(res, 200, {});
});
const wss = new WebSocketServer({ server: mock, path: "/ws/gummies" });
wss.on("connection", (ws) => ws.on("message", (raw) => {
  let m = null; try { m = JSON.parse(raw.toString()); } catch {}
  if (!m || m.type !== "start") return;
  try { received.push(m.payload.context.message.content || ""); } catch { received.push(""); }
  const frames = [{ type: "interaction-ready" }, { type: "step-start", modelId: "claude-opus-4-8" }, { type: "text", text: "working..." }, { type: "finish" }];
  let i = 0; const tick = () => { if (i >= frames.length) return; try { ws.send(JSON.stringify(frames[i++])); } catch {} if (i < frames.length) setTimeout(tick, 60); }; tick();
}));
mock.listen(MOCK_PORT, () => {
  const srv = spawn(process.execPath, [path.join(ROOT, "server", "server.js")], {
    env: { ...process.env, PORT: String(SRV_PORT), GUMLOOP_REFRESH_TOKEN: "mock_rt", GUMLOOP_GUMMIE_ID: "agent_test_1",
      GUMLOOP_API_URL: `http://127.0.0.1:${MOCK_PORT}`, GUMLOOP_WS_URL: `ws://127.0.0.1:${MOCK_PORT}/ws/gummies`,
      FIREBASE_TOKEN_URL: `http://127.0.0.1:${MOCK_PORT}/v1/token`, PD_STATE_FILE: path.join(__dirname, ".bstate.json"), DATABASE_URL: "" },
    stdio: ["ignore", "inherit", "inherit"] });
  process.on("exit", () => { try { srv.kill(); } catch {} });
  console.log("SERVE_READY " + SRV_PORT);
});
