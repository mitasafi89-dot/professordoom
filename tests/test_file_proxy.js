"use strict";
/**
 * E2E test for the hardened /api/file artifact proxy.
 *
 * Verifies the three protections added to stop /api/file being an open egress
 * proxy / SSRF vector:
 *   1. Host allowlist (PD_ARTIFACT_HOSTS) is ALWAYS enforced -- an off-allowlist
 *      host is rejected before any network call, even with PD_ALLOW_LOCAL_FETCH.
 *   2. Redirects are followed manually and re-validated per hop: a redirect to an
 *      allowlisted host is followed; a redirect to an off-allowlist host is blocked.
 *   3. Responses larger than PD_MAX_FILE_BYTES are rejected (413), not buffered.
 *
 * The mock runs on 127.0.0.1, so the server is given PD_ALLOW_LOCAL_FETCH=1 (skip
 * the private-IP SSRF check) AND PD_ARTIFACT_HOSTS="127.0.0.1" (allowlist the
 * mock). The allowlist still rejects any other host, which is what we assert.
 */
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const MOCK_PORT = 4770;
const SRV_PORT = 4771;
const ROOT = path.join(__dirname, "..");
const SMALL = Buffer.alloc(50, 0x41); // 50 bytes "A"
const BIG = Buffer.alloc(200, 0x42);  // 200 bytes "B" (> 100-byte cap)

const mock = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (req.method === "POST" && p === "/v1/token") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id_token: "mock_id", refresh_token: "mock_rt", user_id: "uid_mock", expires_in: "3600" }));
  }
  if (p === "/artifact/small") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(SMALL); }
  if (p === "/artifact/big") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(BIG); }
  if (p === "/redirect") { res.writeHead(302, { location: `http://127.0.0.1:${MOCK_PORT}/artifact/small` }); return res.end(); }
  if (p === "/redirect-evil") { res.writeHead(302, { location: "http://evil.example.com/secret" }); return res.end(); }
  res.writeHead(404); res.end("no");
});

function get(p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: SRV_PORT, path: p, method: "GET" }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    r.on("error", reject); r.end();
  });
}
const FU = (u) => "/api/file?url=" + encodeURIComponent(u);
const m = (p) => `http://127.0.0.1:${MOCK_PORT}${p}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitStatus() { for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${SRV_PORT}/api/status`); if (r.ok) return; } catch {} await sleep(200); } throw new Error("server did not start"); }

(async () => {
  let srv, failures = 0;
  const ok = (c, msg) => { console.log((c ? "  \u2713 " : "  \u2717 ") + msg); if (!c) failures++; };
  await new Promise((r) => mock.listen(MOCK_PORT, r));
  console.log("mock up on", MOCK_PORT);

  srv = spawn(process.execPath, [path.join(ROOT, "server", "server.js")], {
    env: { ...process.env, PORT: String(SRV_PORT),
      GUMLOOP_REFRESH_TOKEN: "mock_rt", GUMLOOP_GUMMIE_ID: "agent_test_1",
      GUMLOOP_API_URL: m(""), GUMLOOP_WS_URL: `ws://127.0.0.1:${MOCK_PORT}/ws/gummies`,
      FIREBASE_TOKEN_URL: m("/v1/token"),
      PD_ALLOW_LOCAL_FETCH: "1", PD_ARTIFACT_HOSTS: "127.0.0.1", PD_MAX_FILE_BYTES: "100",
      PD_STATE_FILE: path.join(__dirname, ".test-state-file.json"), DATABASE_URL: "" },
    stdio: ["ignore", "pipe", "pipe"] });
  srv.stderr.on("data", () => {});
  await waitStatus();

  console.log("\nPART A \u2014 allowlisted host + redirect re-validation");
  const a = await get(FU(m("/artifact/small")));
  ok(a.status === 200 && a.buf.equals(SMALL), "allowlisted artifact served (200, exact bytes)");
  const b = await get(FU(m("/redirect")));
  ok(b.status === 200 && b.buf.equals(SMALL), "redirect to an allowlisted host is followed");

  console.log("\nPART B \u2014 open-proxy / SSRF lockdown");
  const c = await get(FU("http://evil.example.com/secret"));
  ok(c.status === 400, "off-allowlist host rejected with 400 (no fetch) (got " + c.status + ")");
  const d = await get(FU(m("/redirect-evil")));
  ok(d.status === 400, "redirect to an off-allowlist host is blocked (got " + d.status + ")");
  const e = await get("/api/file?url=");
  ok(e.status === 400, "empty url rejected with 400");
  const f = await get(FU("http://169.254.169.254/latest/meta-data/"));
  ok(f.status === 400, "cloud-metadata host (not allowlisted) rejected with 400");

  console.log("\nPART C \u2014 size cap");
  const g = await get(FU(m("/artifact/big")));
  ok(g.status === 413, "response over PD_MAX_FILE_BYTES rejected with 413 (got " + g.status + ")");

  console.log("\n" + (failures === 0 ? "ALL TESTS PASSED" : failures + " ASSERTION(S) FAILED"));
  try { srv.kill(); } catch {}
  try { require("fs").unlinkSync(path.join(__dirname, ".test-state-file.json")); } catch {}
  mock.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("TEST ERROR", e); process.exit(1); });
