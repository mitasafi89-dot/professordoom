"use strict";
/**
 * Mock Gumloop server for E2E tests — stands in for securetoken.googleapis.com,
 * api.gumloop.com, and wss://ws.gumloop.com. Emits a realistic turn frame
 * sequence so the streaming pipeline can be exercised end-to-end without real
 * credentials or the captcha wall.
 */
const http = require("http");
const { WebSocketServer } = require("ws");
const PORT = parseInt(process.env.MOCK_PORT || "4100", 10);

const j = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

const NOW = Date.now();
const conversations = [
  { interaction_id: "int_today1", name: "Calibration of causal claims", state: "completed", created_ts: NOW - 5 * 60 * 1000 },
  { interaction_id: "int_today2", name: "Abstract overreach review",    state: "running",   created_ts: NOW - 2 * 3600 * 1000 },
  { interaction_id: "int_yest",   name: "Methods section gauntlet",     state: "completed", created_ts: NOW - 26 * 3600 * 1000 },
  { interaction_id: "int_week",   name: "Reverse outline pass",         state: "completed", created_ts: NOW - 3 * 86400000 },
  { interaction_id: "int_old",    name: "Initial framing",              state: "error",     created_ts: NOW - 20 * 86400000 },
];

const assistantParts = [
  { type: "reasoning", reasoning: "I need to review the request against the contract's calibration rule before producing any text." },
  { type: "tool_invocation", toolName: "web_search", toolCaption: "Search for supporting sources", toolCallState: "completed" },
  { type: "text", text: "Here is the calibrated analysis you asked for, with every claim tied to evidence." },
];

const server = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (req.method === "POST" && p === "/v1/token")
    return j(res, 200, { id_token: "mock_id_token", refresh_token: "mock_rt", user_id: "uid_mock", expires_in: "3600" });
  if (p === "/gummies" && req.method === "GET")
    return j(res, 200, [{ gummie_id: "agent_test_1", name: "ProfessorDoom (mock)" }]);
  if (/^\/gummies\/[^/]+\/chat/.test(p)) return j(res, 200, { data: conversations });
  if (/^\/gummie_interactions\//.test(p)) {
    const iid = p.split("/").pop();
    const conv = conversations.find((c) => c.interaction_id === iid) || { name: "Conversation" };
    return j(res, 200, { interaction: { name: conv.name, messages: [
      { role: "user", parts: [{ type: "text", text: "Review this section." }] },
      { role: "assistant", models: ["claude-opus-4-8"], parts: assistantParts },
    ] } });
  }
  if (p === "/user_profile") return j(res, 200, { first_name: "Wema", last_name: "F", user_email: "w@example.com" });
  if (p === "/allowed_gummies_models")
    return j(res, 200, { model_groups: [{ groupLabel: "Anthropic", options: [{ label: "Claude 4.8 Opus", value: "gummies_smartest" }] }] });
  if (p === "/last_message") return j(res, 200, { content: lastMessage });
  return j(res, 200, {});
});

let lastMessage = "";
const wss = new WebSocketServer({ server, path: "/ws/gummies" });
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let m = null; try { m = JSON.parse(raw.toString()); } catch {}
    if (!m || m.type !== "start") return;
    try { lastMessage = m.payload.context.message.content || ""; } catch { lastMessage = ""; }
    const frames = [
      { type: "interaction-ready" },
      { type: "step-start", modelId: "claude-opus-4-8" },
      { type: "reasoning", text: "I need to review the request against the contract's calibration rule" },
      { type: "reasoning", text: " before producing any text." },
      { type: "tool_invocation", toolName: "web_search", toolCaption: "Search for supporting sources", toolCallState: "running" },
      { type: "tool_invocation", toolName: "web_search", toolCaption: "Search for supporting sources", toolCallState: "completed" },
      { type: "text", text: "Here is the calibrated analysis " },
      { type: "text", text: "you asked for, with every claim " },
      { type: "text", text: "tied to evidence." },
      { type: "finish" },
    ];
    let i = 0;
    const tick = () => {
      if (i >= frames.length) return;
      try { ws.send(JSON.stringify(frames[i++])); } catch {}
      if (i < frames.length) setTimeout(tick, 300);
    };
    tick();
  });
});

server.listen(PORT, () => console.log("mock gumloop on " + PORT));
