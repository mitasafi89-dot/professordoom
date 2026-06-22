"use strict";

const $ = (id) => document.getElementById(id);
const statusline = $("statusline");
const noticeEl = $("notice");

async function refreshStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    statusline.innerHTML = s.configured
      ? 'Status: <strong style="color:#7ee787">configured</strong> &middot; agent <code>' + (s.gummieId || "—") + "</code>"
      : 'Status: <strong style="color:#ff9aa0">not configured</strong> — no refresh token set.';
    $("dbStatus").innerHTML = s.dbConnected
      ? 'Database: <strong style="color:#7ee787">connected</strong> &middot; config persists across restarts'
      : 'Database: <strong style="color:#ffcf7a">not connected</strong> — set DATABASE_URL to persist config.';
    if (s.gummieId) $("gummieId").placeholder = s.gummieId;
    if (s.turnstileSiteKey) $("turnstileSiteKey").placeholder = s.turnstileSiteKey;
    if (s.hcaptchaSiteKey) $("hcaptchaSiteKey").placeholder = s.hcaptchaSiteKey;
    if (s.port) $("port").placeholder = s.port;
    if (s.firebaseConfigured) $("firebaseApiKey").placeholder = "configured — leave blank to keep current";
  } catch {
    statusline.textContent = "Status: server offline.";
  }
}

function notify(msg, ok) { noticeEl.textContent = msg; noticeEl.className = "notice " + (ok ? "ok" : "err"); }

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let data = {}; try { data = await r.json(); } catch {}
  return { ok: r.ok, data };
}

// ---- Extract refresh token + API key from a pasted firebase auth blob ----
function extractBlob() {
  const raw = $("authBlob").value.trim();
  const el = $("extractNotice");
  if (!raw) { el.textContent = "Paste the auth blob first."; el.className = "notice err"; return; }
  let apiKey = "", refreshToken = "";
  try {
    const o = JSON.parse(raw);
    const v = o.value || o;
    apiKey = v.apiKey || "";
    refreshToken = (v.stsTokenManager && v.stsTokenManager.refreshToken) || v.refreshToken || "";
  } catch {
    const ak = raw.match(/["']?apiKey["']?\s*[:=]\s*["']([^"']+)["']/);
    const rt = raw.match(/["']?refreshToken["']?\s*[:=]\s*["']([^"']+)["']/);
    if (ak) apiKey = ak[1];
    if (rt) refreshToken = rt[1];
  }
  if (!refreshToken && !apiKey) { el.textContent = "Could not find a refresh token or API key in that text."; el.className = "notice err"; return; }
  if (refreshToken) $("refreshToken").value = refreshToken;
  if (apiKey) $("firebaseApiKey").value = apiKey;
  el.textContent = "✓ Extracted " + [refreshToken ? "refresh token" : "", apiKey ? "API key" : ""].filter(Boolean).join(" + ") + ". Review, then Save configuration.";
  el.className = "notice ok";
}

async function save() {
  const password = $("password").value;
  if (!password) return notify("Enter the admin password.", false);
  const body = { password };
  const map = { refreshToken: "refreshToken", gummieId: "gummieId", firebaseApiKey: "firebaseApiKey",
                turnstileSiteKey: "turnstileSiteKey", hcaptchaSiteKey: "hcaptchaSiteKey", port: "port", newPassword: "newPassword" };
  for (const k in map) { const v = $(map[k]).value.trim(); if (v) body[k] = v; }
  $("save").disabled = true;
  try {
    const { ok, data } = await post("/api/admin/creds", body);
    if (!ok) { notify(data.error || "Update failed.", false); return; }
    let msg = "Saved. Session is " + (data.configured ? "configured." : "still missing a refresh token.");
    if (data.passwordChanged) msg += " Admin password updated.";
    if (data.portChanged) msg += " Port change takes effect after a restart.";
    notify(msg, true);
    $("refreshToken").value = ""; $("firebaseApiKey").value = ""; $("newPassword").value = ""; $("authBlob").value = "";
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

// ---- Skills ----
function skillNotify(msg, ok) { const el = $("skillNotice"); el.textContent = msg; el.className = "notice " + (ok ? "ok" : "err"); }

let SKILLS = [];
async function loadSkills() {
  try {
    const { skills } = await (await fetch("/api/skills")).json();
    SKILLS = skills || [];
    $("skillSelect").innerHTML = SKILLS.map((s) => '<option value="' + s.slug + '">' + s.label + "</option>").join("");
    onSkillChange();
  } catch { /* ignore */ }
}

function currentSkill() { return SKILLS.find((s) => s.slug === $("skillSelect").value); }

async function onSkillChange() {
  const s = currentSkill();
  if (!s) return;
  $("skillStatus").innerHTML = s.hasContract
    ? 'Contract: <strong style="color:#7ee787">set</strong>' + (s.filename ? " &middot; <code>" + s.filename + "</code>" : "")
    : 'Contract: <strong style="color:#ffcf7a">none yet</strong>';
  // Load existing contract text for editing (needs the admin password).
  const password = $("password").value;
  if (password && s.hasContract) {
    const { ok, data } = await post("/api/admin/skill/get", { password, slug: s.slug });
    if (ok) $("skillText").value = data.contract || "";
  } else {
    $("skillText").value = "";
  }
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const b64 = String(r.result).split(",").pop(); resolve(b64); };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function saveSkill() {
  const password = $("password").value;
  if (!password) return skillNotify("Enter the admin password.", false);
  const s = currentSkill();
  if (!s) return skillNotify("Pick a skill.", false);
  const file = $("skillFile").files[0];
  const text = $("skillText").value.trim();
  if (!file && !text) return skillNotify("Upload a document or paste the contract text.", false);
  $("saveSkill").disabled = true;
  skillNotify("Saving…", true);
  try {
    const body = { password, slug: s.slug };
    if (file) { body.filename = file.name; body.contentBase64 = await readFileBase64(file); }
    else { body.text = text; }
    const { ok, data } = await post("/api/admin/skill", body);
    if (!ok) skillNotify(data.error || "Save failed.", false);
    else { skillNotify("✓ Saved " + data.chars + " characters for " + data.label + ".", true); $("skillFile").value = ""; await loadSkills(); }
  } catch { skillNotify("Could not reach the server.", false); }
  finally { $("saveSkill").disabled = false; }
}

$("extract").addEventListener("click", extractBlob);
$("save").addEventListener("click", save);
$("verify").addEventListener("click", verify);
$("clear").addEventListener("click", clearSession);
$("skillSelect").addEventListener("change", onSkillChange);
$("saveSkill").addEventListener("click", saveSkill);
$("password").addEventListener("change", onSkillChange);
refreshStatus();
loadSkills();
