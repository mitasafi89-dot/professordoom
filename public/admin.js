"use strict";

const $ = (id) => document.getElementById(id);

function notify(msg, ok, id) {
  const el = $(id || "notice"); if (!el) return;
  el.textContent = msg; el.className = "notice " + (ok ? "ok" : "err");
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let data = {}; try { data = await r.json(); } catch {}
  return { ok: r.ok, data };
}

// ---------- tabs ----------
document.querySelectorAll(".admin-tabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".admin-tabs .tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ---------- status chips ----------
function setChip(id, text, level) {
  const el = $(id); if (!el) return;
  el.className = "chip " + (level || "");
  el.innerHTML = '<span class="cdot"></span>' + text;
}

// Whether the server enforces an admin password. When false, we hide the field
// entirely and never ask for one.
let ADMIN_AUTH_REQUIRED = false;

// Reflect/hide the password requirement in the UI.
function applyAuthRequirement(required) {
  ADMIN_AUTH_REQUIRED = !!required;
  const pwRow = document.querySelector(".admin-pw");
  if (pwRow) pwRow.style.display = ADMIN_AUTH_REQUIRED ? "" : "none";
}

async function refreshStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    applyAuthRequirement(s.adminAuthRequired);
    if (s.configured) setChip("chipSession", s.gummieId ? "Configured" : "No agent set", s.gummieId ? "ok" : "warn");
    else setChip("chipSession", "Not configured", "bad");
    setChip("chipDb", s.dbConnected ? "Database on" : "Database off", s.dbConnected ? "ok" : "warn");
    if (s.turnstileSiteKey) $("turnstileSiteKey").placeholder = s.turnstileSiteKey;
    if (s.hcaptchaSiteKey) $("hcaptchaSiteKey").placeholder = s.hcaptchaSiteKey;
    if (s.port) $("port").placeholder = s.port;
    if (s.firebaseConfigured) $("firebaseApiKey").placeholder = "configured — leave blank to keep current";
  } catch {
    setChip("chipSession", "Server offline", "bad");
  }
}

// Repopulate the form with the CURRENTLY-STORED values so a page refresh shows
// your settings instead of looking blank. This is the fix for "refreshing clears
// all my settings" — nothing was lost; the form just wasn't reading it back.
async function loadConfig() {
  try {
    const c = await (await fetch("/api/admin/config")).json();
    if (c.gummieId) $("gummieId").value = c.gummieId;
    if (c.port) $("port").value = c.port;
    if (c.turnstileSiteKey) $("turnstileSiteKey").value = c.turnstileSiteKey;
    if (c.hcaptchaSiteKey) $("hcaptchaSiteKey").value = c.hcaptchaSiteKey;
    if (c.refreshTokenConfigured) {
      $("refreshToken").placeholder = "✓ stored — leave blank to keep current";
    }
    if (c.firebaseConfigured) {
      $("firebaseApiKey").placeholder = "✓ stored — leave blank to keep current";
    }
  } catch { /* ignore */ }
}

// ---------- autonomous setup: paste blob -> everything ----------
// One action does it all: extract the refresh token + API key, auto-detect the
// account's agents, auto-select the Agent ID, and persist. No buttons to click,
// no Agent ID to type. Fires automatically when you paste the blob.
let autoConnecting = false;
async function autoConnectFromBlob(opts) {
  opts = opts || {};
  const raw = $("authBlob").value.trim();
  if (!raw) {
    if (!opts.silent) notify("Paste the firebase:authUser:… value first.", false, "extractNotice");
    return;
  }
  if (autoConnecting) return;
  autoConnecting = true;
  notify("Connecting — extracting token, detecting your agent…", true, "extractNotice");
  try {
    const body = { blob: raw };
    if (ADMIN_AUTH_REQUIRED) body.password = $("password").value;
    const { ok, data } = await post("/api/admin/blob", body);
    if (!ok) { notify(data.error || "Couldn't connect from that blob.", false, "extractNotice"); return; }

    // Reflect detected agent(s) in the UI.
    if (data.gummieId) $("gummieId").value = data.gummieId;
    const agents = data.agents || [];
    if (agents.length > 1) {
      const sel = $("agentSelect");
      sel.innerHTML = agents.map((x) => '<option value="' + x.id + '"' + (x.id === data.gummieId ? " selected" : "") + '>' + x.name + " — " + x.id + "</option>").join("");
      $("agentPickWrap").style.display = "";
      sel.value = data.gummieId;
    } else {
      $("agentPickWrap").style.display = "none";
    }

    let msg = "✓ Connected.";
    if (agents.length === 1) msg += " Agent auto-selected: " + (agents[0].name || data.gummieId) + ".";
    else if (agents.length > 1) msg += " " + agents.length + " agents found — default selected, switch above if needed.";
    else if (data.detectError) msg += " (Token saved, but agent list couldn't load: " + data.detectError + ")";
    msg += data.apiKeyDetected ? " API key detected." : "";
    msg += " Settings saved" + (data.dbConnected ? " to Supabase." : " locally.");
    notify(msg, true, "extractNotice");
    $("authBlob").value = "";
    refreshStatus();
  } catch { notify("Could not reach the server.", false, "extractNotice"); }
  finally { autoConnecting = false; }
}

// ---------- save (session + advanced share one payload) ----------
async function save(noticeId, btnId) {
  const password = $("password").value;
  if (ADMIN_AUTH_REQUIRED && !password) return notify("Enter the admin password.", false, noticeId);
  const body = { password };
  const fields = ["refreshToken", "gummieId", "firebaseApiKey", "turnstileSiteKey", "hcaptchaSiteKey", "port", "newPassword"];
  fields.forEach((k) => { const v = $(k).value.trim(); if (v) body[k] = v; });
  const btn = $(btnId); if (btn) btn.disabled = true;
  try {
    const { ok, data } = await post("/api/admin/creds", body);
    if (!ok) { notify(data.error || "Update failed.", false, noticeId); return; }
    let msg = "Saved. Session is " + (data.configured ? "configured." : "still missing a refresh token.");
    if (data.passwordChanged) msg += " Password updated.";
    if (data.portChanged) msg += " Port applies after restart.";
    notify(msg, true, noticeId);
    $("refreshToken").value = ""; $("firebaseApiKey").value = ""; $("newPassword").value = ""; $("authBlob").value = "";
    refreshStatus();
  } catch { notify("Could not reach the server.", false, noticeId); }
  finally { if (btn) btn.disabled = false; }
}

async function verify() {
  const password = $("password").value;
  if (ADMIN_AUTH_REQUIRED && !password) return notify("Enter the admin password to verify.", false);
  notify("Minting a token…", true);
  const { ok, data } = await post("/api/admin/verify", { password });
  if (ok) notify("✓ Session works. Authenticated as uid " + data.uid, true);
  else notify("Verify failed: " + (data.error || "unknown"), false);
}

async function clearSession() {
  const password = $("password").value;
  if (ADMIN_AUTH_REQUIRED && !password) return notify("Enter the admin password to clear.", false);
  const { ok, data } = await post("/api/admin/clear", { password });
  if (ok) { notify("Stored session cleared.", true); refreshStatus(); }
  else notify(data.error || "Clear failed.", false);
}

// ---------- detect agents ----------
async function detectAgents() {
  const password = $("password").value;
  if (ADMIN_AUTH_REQUIRED && !password) return notify("Enter the admin password first.", false, "agentNotice");
  $("detectAgents").disabled = true;
  notify("Detecting…", true, "agentNotice");
  try {
    const refreshToken = $("refreshToken").value.trim();
    const firebaseApiKey = $("firebaseApiKey").value.trim();
    const { ok, data } = await post("/api/admin/agents", { password, refreshToken, firebaseApiKey });
    if (!ok) return notify(data.error || "Could not detect agents.", false, "agentNotice");
    const agents = data.agents || [];
    if (!agents.length) return notify("No agents found — enter the Agent ID manually.", false, "agentNotice");
    const sel = $("agentSelect");
    sel.innerHTML = agents.map((x) => '<option value="' + x.id + '">' + x.name + " — " + x.id + "</option>").join("");
    $("agentPickWrap").style.display = "";
    $("gummieId").value = agents[0].id; sel.value = agents[0].id;
    notify("✓ Found " + agents.length + " agent(s). " + (agents.length === 1 ? "Filled in — Save session." : "Pick one, then Save."), true, "agentNotice");
  } catch { notify("Could not reach the server.", false, "agentNotice"); }
  finally { $("detectAgents").disabled = false; }
}

// ---------- skills ----------
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
  const s = currentSkill(); if (!s) return;
  $("skillStatus").innerHTML = s.hasContract
    ? '<span class="cdot ok"></span>Contract set' + (s.filename ? ' &middot; <code>' + s.filename + "</code>" : "")
    : '<span class="cdot warn"></span>No contract yet';
  const password = $("password").value;
  if ((!ADMIN_AUTH_REQUIRED || password) && s.hasContract) {
    const { ok, data } = await post("/api/admin/skill/get", { password, slug: s.slug });
    $("skillText").value = ok ? (data.contract || "") : "";
  } else { $("skillText").value = ""; }
}
function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",").pop());
    r.onerror = reject; r.readAsDataURL(file);
  });
}
async function saveSkill() {
  const password = $("password").value;
  if (ADMIN_AUTH_REQUIRED && !password) return notify("Enter the admin password.", false, "skillNotice");
  const s = currentSkill(); if (!s) return notify("Pick a skill.", false, "skillNotice");
  const file = $("skillFile").files[0];
  const text = $("skillText").value.trim();
  if (!file && !text) return notify("Upload a document or paste the contract text.", false, "skillNotice");
  $("saveSkill").disabled = true; notify("Saving…", true, "skillNotice");
  try {
    const body = { password, slug: s.slug };
    if (file) { body.filename = file.name; body.contentBase64 = await readFileBase64(file); }
    else { body.text = text; }
    const { ok, data } = await post("/api/admin/skill", body);
    if (!ok) notify(data.error || "Save failed.", false, "skillNotice");
    else { notify("✓ Saved " + data.chars + " characters for " + data.label + ".", true, "skillNotice"); $("skillFile").value = ""; await loadSkills(); }
  } catch { notify("Could not reach the server.", false, "skillNotice"); }
  finally { $("saveSkill").disabled = false; }
}

// ---------- wiring ----------
// The blob button now runs the full autonomous connect (extract + detect + select + save).
$("extract").addEventListener("click", () => autoConnectFromBlob());
// Auto-fire the moment a blob is pasted — no clicks needed.
$("authBlob").addEventListener("paste", () => setTimeout(() => autoConnectFromBlob({ silent: true }), 80));
// Manual Detect remains as a fallback for typed-in tokens.
$("detectAgents").addEventListener("click", detectAgents);
$("agentSelect").addEventListener("change", () => { $("gummieId").value = $("agentSelect").value; });
$("save").addEventListener("click", () => save("notice", "save"));
$("saveAdvanced").addEventListener("click", () => save("advNotice", "saveAdvanced"));
$("verify").addEventListener("click", verify);
$("clear").addEventListener("click", clearSession);
$("skillSelect").addEventListener("change", onSkillChange);
$("saveSkill").addEventListener("click", saveSkill);
$("password").addEventListener("change", onSkillChange);
refreshStatus();
loadConfig();
loadSkills();
