"use strict";

const $ = (id) => document.getElementById(id);
const statusline = $("statusline");
const noticeEl = $("notice");

async function refreshStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    statusline.innerHTML = s.configured
      ? 'Status: <strong style="color:#7ee787">configured</strong> · gummie <code>' + (s.gummieId || "—") + "</code>"
      : 'Status: <strong style="color:#ff9aa0">not configured</strong> — no refresh token set.';
    $("dbStatus").innerHTML = s.dbConnected
      ? 'Database: <strong style="color:#7ee787">connected</strong> · config persists across restarts'
      : 'Database: <strong style="color:#ffcf7a">not connected</strong> — set DATABASE_URL to persist config.';
    // Pre-fill non-secret fields as placeholders so admins can see current values.
    if (s.gummieId) $("gummieId").placeholder = s.gummieId;
    if (s.turnstileSiteKey) $("turnstileSiteKey").placeholder = s.turnstileSiteKey;
    if (s.hcaptchaSiteKey) $("hcaptchaSiteKey").placeholder = s.hcaptchaSiteKey;
    if (s.port) $("port").placeholder = s.port;
    if (s.firebaseConfigured) $("firebaseApiKey").placeholder = "configured — leave blank to keep current";
  } catch {
    statusline.textContent = "Status: server offline.";
  }
}

function notify(msg, ok) {
  noticeEl.textContent = msg;
  noticeEl.className = "notice " + (ok ? "ok" : "err");
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let data = {}; try { data = await r.json(); } catch {}
  return { ok: r.ok, data };
}

async function save() {
  const password = $("password").value;
  if (!password) return notify("Enter the admin password.", false);
  const body = { password };
  const rt = $("refreshToken").value.trim();
  const gid = $("gummieId").value.trim();
  const fak = $("firebaseApiKey").value.trim();
  const tsk = $("turnstileSiteKey").value.trim();
  const hsk = $("hcaptchaSiteKey").value.trim();
  const port = $("port").value.trim();
  const np = $("newPassword").value;
  if (rt) body.refreshToken = rt;
  if (gid) body.gummieId = gid;
  if (fak) body.firebaseApiKey = fak;
  if (tsk) body.turnstileSiteKey = tsk;
  if (hsk) body.hcaptchaSiteKey = hsk;
  if (port) body.port = port;
  if (np) body.newPassword = np;

  $("save").disabled = true;
  try {
    const { ok, data } = await post("/api/admin/creds", body);
    if (!ok) { notify(data.error || "Update failed.", false); return; }
    let msg = "Saved. Session is " + (data.configured ? "configured." : "still missing a refresh token.");
    if (data.passwordChanged) msg += " Admin password updated — use the new one next time.";
    if (data.portChanged) msg += " Port change takes effect after a restart.";
    notify(msg, true);
    $("refreshToken").value = "";
    $("firebaseApiKey").value = "";
    $("newPassword").value = "";
    refreshStatus();
  } catch { notify("Could not reach the server.", false); }
  finally { $("save").disabled = false; }
}

async function verify() {
  const password = $("password").value;
  if (!password) return notify("Enter the admin password to verify.", false);
  notify("Minting a token…", true);
  const { ok, data } = await post("/api/admin/verify", { password });
  if (ok) notify("✓ Session works. Authenticated as uid " + data.uid, true);
  else notify("Verify failed: " + (data.error || "unknown"), false);
}

async function clearSession() {
  const password = $("password").value;
  if (!password) return notify("Enter the admin password to clear.", false);
  const { ok, data } = await post("/api/admin/clear", { password });
  if (ok) { notify("Stored session cleared.", true); refreshStatus(); }
  else notify(data.error || "Clear failed.", false);
}

$("save").addEventListener("click", save);
$("verify").addEventListener("click", verify);
$("clear").addEventListener("click", clearSession);
refreshStatus();
