"use strict";
/**
 * E2E test for PROCESSED-DOCUMENT persistence.
 *
 * A send whose REST reconciliation returns a `file` part proves the server
 * captures the artifact bytes into pd_documents (in-memory fallback here, no DB),
 * serves them back durably from /api/documents/:id (inline + ?dl=1), is
 * idempotent for the same artifact, and versions a re-export with new content.
 */
const http = require("http");
const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const path = require("path");

const MOCK_PORT = 4750;
const SRV_PORT = 4751;
const ROOT = path.join(__dirname, "..");

// Artifact store the mock serves, and the parts the REST interaction returns.
const artifacts = {
  "manuscript.docx": { ctype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", body: Buffer.from("MANUSCRIPT-PHASE-1-BYTES") },
  "references.md": { ctype: "text/markdown", body: Buffer.from("# References\n1. Real, A. (2026).") },
};
function artUrl(name) { return `http://127.0.0.1:${MOCK_PORT}/artifact/${name}`; }
let currentParts = [];

const j = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const mock = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (req.method === "POST" && p === "/v1/token")
    return j(res, 200, { id_token: "mock_id", refresh_token: "mock_rt", user_id: "uid_mock", expires_in: "3600" });
  if (p.startsWith("/artifact/")) {
    const name = decodeURIComponent(p.slice("/artifact/".length));
    const a = artifacts[name];
    if (!a) { res.writeHead(404); return res.end("no"); }
    res.writeHead(200, { "content-type": a.ctype }); return res.end(a.body);
  }
  if (/^\/gummie_interactions\//.test(p))
    return j(res, 200, { interaction: { name: "SME manuscript", messages: [{ role: "assistant", parts: currentParts }] } });
  return j(res, 200, {});
});
const wss = new WebSocketServer({ server: mock, path: "/ws/gummies" });
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let m = null; try { m = JSON.parse(raw.toString()); } catch {}
    if (!m || m.type !== "start") return;
    const frames = [{ type: "interaction-ready" }, { type: "text", text: "phase done" }, { type: "finish" }];
    let i = 0; const tick = () => { if (i >= frames.length) return; try { ws.send(JSON.stringify(frames[i++])); } catch {} if (i < frames.length) setTimeout(tick, 40); }; tick();
  });
});

function req(method, p, { json, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = json ? JSON.stringify(json) : null;
    const r = http.request({ host: "127.0.0.1", port: SRV_PORT, path: p, method,
      headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const b = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buf: b, body: (() => { try { return JSON.parse(b.toString()); } catch { return raw ? b : b.toString(); } })() }); });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}
function sendStream(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port: SRV_PORT, path: "/api/send/stream", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let buf = "", start = null;
      res.on("data", (ch) => { buf += ch.toString();
        let idx; while ((idx = buf.indexOf("\n\n")) !== -1) { const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          let ev = "message", d = ""; chunk.split("\n").forEach((l) => { if (l.startsWith("event:")) ev = l.slice(6).trim(); else if (l.startsWith("data:")) d += l.slice(5).trim(); });
          if (ev === "start") { try { start = JSON.parse(d); } catch {} } } });
      res.on("end", () => resolve({ start }));
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
      PD_ALLOW_LOCAL_FETCH: "1", // allow fetching the 127.0.0.1 mock artifacts
      PD_STATE_FILE: path.join(__dirname, ".test-state-docs.json"), DATABASE_URL: "" },
    stdio: ["ignore", "pipe", "pipe"] });
  srv.stderr.on("data", () => {});
  await waitStatus();

  console.log("\nPART A \u2014 capture a deliverable on a finished turn");
  currentParts = [
    { type: "text", text: "Phase 1 complete." },
    { type: "file", file: { filename: "manuscript.docx", media_type: artifacts["manuscript.docx"].ctype, artifact_url: artUrl("manuscript.docx") } },
  ];
  const t1 = await sendStream({ message: "write the manuscript", turnstile_token: "na", hcaptcha_token: "h" });
  const iid = t1.start && t1.start.interaction_id;
  await sleep(600); // persistDocuments is fire-and-forget after `done`

  let list = (await req("GET", "/api/documents?interaction_id=" + encodeURIComponent(iid))).body;
  ok(list.documents && list.documents.length === 1, "1 document captured for the conversation (got " + (list.documents || []).length + ")");
  const doc = (list.documents || [])[0] || {};
  ok(doc.filename === "manuscript.docx", "document filename stored (" + doc.filename + ")");
  ok(doc.bytes === artifacts["manuscript.docx"].body.length, "stored byte length matches artifact (" + doc.bytes + ")");

  console.log("\nPART B \u2014 serve bytes back durably");
  const dl = await req("GET", "/api/documents/" + doc.id + "?dl=1", { raw: true });
  ok(dl.status === 200 && Buffer.isBuffer(dl.buf) && dl.buf.equals(artifacts["manuscript.docx"].body), "download returns exact stored bytes");
  ok(/attachment/.test(dl.headers["content-disposition"] || ""), "download sets attachment disposition");
  const inl = await req("GET", "/api/documents/" + doc.id, { raw: true });
  ok(inl.status === 200 && inl.buf.equals(artifacts["manuscript.docx"].body), "inline serve returns the bytes");

  console.log("\nPART C \u2014 idempotent + versioning + new deliverable");
  await sendStream({ interaction_id: iid, message: "continue", turnstile_token: "na", hcaptcha_token: "h" });
  await sleep(600);
  list = (await req("GET", "/api/documents?interaction_id=" + encodeURIComponent(iid))).body;
  ok(list.documents.length === 1, "re-export of the SAME artifact does not duplicate (still 1)");

  // New version of manuscript (new url + content) + a brand-new deliverable.
  artifacts["manuscript.docx"].body = Buffer.from("MANUSCRIPT-PHASE-2-REVISED");
  currentParts = [
    { type: "file", file: { filename: "manuscript.docx", media_type: artifacts["manuscript.docx"].ctype, artifact_url: artUrl("manuscript.docx") + "?v=2" } },
    { type: "file", file: { filename: "references.md", media_type: artifacts["references.md"].ctype, artifact_url: artUrl("references.md") } },
  ];
  await sendStream({ interaction_id: iid, message: "continue", turnstile_token: "na", hcaptcha_token: "h" });
  await sleep(700);
  list = (await req("GET", "/api/documents?interaction_id=" + encodeURIComponent(iid))).body;
  ok(list.documents.length === 2, "a new deliverable adds a row (now 2)");
  const man = list.documents.find((d) => d.filename === "manuscript.docx");
  ok(man && man.version >= 2, "re-exported manuscript bumped to version >= 2 (v" + (man && man.version) + ")");
  const man2 = await req("GET", "/api/documents/" + man.id, { raw: true });
  ok(man2.buf.equals(artifacts["manuscript.docx"].body), "manuscript serves the REVISED bytes after re-export");

  console.log("\n" + (failures === 0 ? "ALL TESTS PASSED" : failures + " ASSERTION(S) FAILED"));
  try { srv.kill(); } catch {}
  try { require("fs").unlinkSync(path.join(__dirname, ".test-state-docs.json")); } catch {}
  mock.close(); wss.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("TEST ERROR", e); process.exit(1); });
