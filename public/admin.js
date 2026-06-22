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

async function refreshStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    if (s.configured) setChip("chipSession", s.gummieId ? "Configured" : "No agent set", s.gummieId ? "ok" : "warn");
    else setChip("chipSession", "Not configured", "bad");
    setChip("chipDb", s.dbConnected ? "Database on" : "Database off", s.dbConnected ? "ok" : "warn");
    if (s.gummieId) $("gummieId").placeholder = s.gummieId;
    if (s.turnstileSiteKey) $("turnstileSiteKey").placeholder = s.turnstileSiteKey;
    if (s.hcaptchaSiteKey) $("hcaptchaSiteKey").placeholder = s.hcaptchaSiteKey;
    if (s.port) $("port").placeholder = s.port;
    if (s.firebaseConfigured) $("firebaseApiKey").placeholder = "configured — leave blank to keep current";
  } catch {
    setChip("chipSession", "Server offline", "bad");
  }
}

// ---------- auth-blob extractor ----------
function extractBlob() {
  const raw = $("authBlob").value.trim();
  if (!raw) return notify("Paste the auth blob first.", false, "extractNotice");
  let apiKey = "", refreshToken = "";
  try {
    const o = JSON.parse(raw); const v = o.value || o;
    apiKey = v.apiKey || "";
    refreshToken = (v.stsTokenManager && v.stsTokenManager.refreshToken) || v.refreshToken || "";
  } catch {
    const ak = raw.match(/["']?apiKey["']?\s*[:=]\s*["']([^"']+)["']/);
    const rt = raw.match(/["']?refreshToken["']?\s*[:=]\s*["']([^"']+)["']/);
    if (ak) apiKey = ak[1];
    if (rt) refreshToken = rt[1];
  }
  if (!refreshToken && !apiKey) return notify("Could not find a refresh token or API key in that text.", false, "extractNotice");
  if (refreshToken) $("refreshToken").value = refreshToken;
  if (apiKey) $("firebaseApiKey").value = apiKey;
  notify("✓ Extracted " + [refreshToken ? "refresh token" : "", apiKey ? "API key" : ""].filter(Boolean).join(" + ") + ". Now Save session.", true, "extractNotice");
}

// ---------- save (session + advanced share one payload) ----------
async function save(noticeId, btnId) {
  const password = $("password").value;
  if (!password) return notify("Enter the admin password.", false, noticeId);
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

// ---------- detect agents ----------
async function detectAgents() {
  const password = $("password").value;
  if (!password) return notify("Enter the admin password first.", false, "agentNotice");
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
  if (password && s.hasContract) {
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
  if (!password) return notify("Enter the admin password.", false, "skillNotice");
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
$("extract").addEventListener("click", extractBlob);
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
loadSkills();
