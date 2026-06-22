"use strict";

/**
 * ProfessorDoom — custom UI over a Gumloop session, with Postgres persistence.
 *
 * Auth: a Firebase refresh token (project agenthub-dev), held server-side only.
 * The server mints short-lived id_tokens from it, proxies REST reads to
 * api.gumloop.com, and sends chat over wss://ws.gumloop.com/ws/gummies
 * (each message requires browser-solved Turnstile + hCaptcha tokens).
 *
 * Config model: environment variables SEED the initial values. The /admin
 * dashboard writes config to Postgres (pd_config), which becomes the source of
 * truth on subsequent boots. This lets a different Gumloop account/deployment be
 * set up entirely from /admin without editing code.
 *
 * The database connection itself is set ONCE via DATABASE_URL and is not
 * editable from /admin (it does not change between accounts).
 */

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "8mb" }));

const API = "https://api.gumloop.com";
const WS_URL = "wss://ws.gumloop.com/ws/gummies";
const ORIGIN = "https://www.gumloop.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// Platform defaults (shared across Gumloop accounts). Overridable via env or /admin.
const DEFAULT_FIREBASE_API_KEY = "AIzaSyCYuXqbJ0YBNltoGS4-7Y6Hozrra8KKmaE";
const DEFAULT_TURNSTILE_SITE_KEY = "0x4AAAAAACMum7HpvvFmcf2r";
const DEFAULT_HCAPTCHA_SITE_KEY = "5dd279d6-b56e-4dec-b474-6426c2f83150";

function parsePort(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

const state = {
  refreshToken: process.env.GUMLOOP_REFRESH_TOKEN || "",
  gummieId: process.env.GUMLOOP_GUMMIE_ID || "",
  idToken: "",
  uid: "",
  idTokenExp: 0,
  dbUrl: process.env.DATABASE_URL || "",
  dbConnected: false,
  adminPassword: process.env.ADMIN_PASSWORD || "Create1#",
  firebaseApiKey: process.env.FIREBASE_API_KEY || DEFAULT_FIREBASE_API_KEY,
  turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || DEFAULT_TURNSTILE_SITE_KEY,
  hcaptchaSiteKey: process.env.HCAPTCHA_SITE_KEY || DEFAULT_HCAPTCHA_SITE_KEY,
  port: parsePort(process.env.PORT, 3000),
};

// Working-contract "skills". Each skill carries a guideline document (the contract)
// that the agent operates under. Contracts persist in the database.
const DEFAULT_SKILLS = [
  { slug: "manuscript-writing", label: "Manuscript Writing" },
  { slug: "revision", label: "Revision" },
  { slug: "dissertation-writing", label: "Dissertation Writing" },
];
state.skills = {};
DEFAULT_SKILLS.forEach((s) => { state.skills[s.slug] = { slug: s.slug, label: s.label, filename: "", contract: "" }; });

// Constant-time admin password check (avoids timing leaks).
function checkPassword(p) {
  if (typeof p !== "string" || !p) return false;
  const a = Buffer.from(p);
  const b = Buffer.from(state.adminPassword);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ===================== Postgres persistence =====================
let pool = null;

function needsSsl(url) {
  return /sslmode=require/.test(url) || /neon\.tech|supabase|render\.com|amazonaws\.com|heroku/.test(url);
}

async function connectDb(url) {
  const p = new Pool({
    connectionString: url,
    ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined,
    max: 5,
    connectionTimeoutMillis: 8000,
  });
  await p.query("SELECT 1");
  await p.query(`CREATE TABLE IF NOT EXISTS pd_config (
    key text PRIMARY KEY, value text, updated_at timestamptz DEFAULT now())`);
  await p.query(`CREATE TABLE IF NOT EXISTS pd_messages (
    id bigserial PRIMARY KEY, interaction_id text, role text, content text,
    model text, created_at timestamptz DEFAULT now())`);
  await p.query(`CREATE TABLE IF NOT EXISTS pd_skills (
    slug text PRIMARY KEY, label text, filename text, contract text,
    updated_at timestamptz DEFAULT now())`);
  if (pool) { try { await pool.end(); } catch {} }
  pool = p;
  state.dbUrl = url;
  state.dbConnected = true;
  await loadConfigFromDb();
  await loadSkillsFromDb();
}

async function loadConfigFromDb() {
  if (!pool) return;
  const r = await pool.query("SELECT key, value FROM pd_config");
  const m = {};
  r.rows.forEach((x) => { m[x.key] = x.value; });
  // Persisted config is authoritative once set via /admin; it overrides env-seeded defaults.
  if (m.refresh_token) {
    if (m.refresh_token !== state.refreshToken) { state.idToken = ""; state.idTokenExp = 0; }
    state.refreshToken = m.refresh_token;
  }
  if (m.gummie_id) state.gummieId = m.gummie_id;
  if (m.admin_password) state.adminPassword = m.admin_password;
  if (m.firebase_api_key) {
    if (m.firebase_api_key !== state.firebaseApiKey) { state.idToken = ""; state.idTokenExp = 0; }
    state.firebaseApiKey = m.firebase_api_key;
  }
  if (m.turnstile_site_key) state.turnstileSiteKey = m.turnstile_site_key;
  if (m.hcaptcha_site_key) state.hcaptchaSiteKey = m.hcaptcha_site_key;
  if (m.port) state.port = parsePort(m.port, state.port);
}

async function saveConfigToDb() {
  if (!pool) return;
  const up = (k, v) => pool.query(
    `INSERT INTO pd_config(key, value, updated_at) VALUES($1, $2, now())
     ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = now()`, [k, v]);
  try {
    if (state.refreshToken) await up("refresh_token", state.refreshToken);
    if (state.gummieId) await up("gummie_id", state.gummieId);
    if (state.adminPassword) await up("admin_password", state.adminPassword);
    if (state.firebaseApiKey) await up("firebase_api_key", state.firebaseApiKey);
    if (state.turnstileSiteKey) await up("turnstile_site_key", state.turnstileSiteKey);
    if (state.hcaptchaSiteKey) await up("hcaptcha_site_key", state.hcaptchaSiteKey);
    if (state.port) await up("port", String(state.port));
  } catch (e) { console.error("saveConfigToDb:", e.message); }
}

async function loadSkillsFromDb() {
  if (!pool) return;
  for (const sk of DEFAULT_SKILLS) {
    await pool.query(
      `INSERT INTO pd_skills(slug, label) VALUES($1, $2)
       ON CONFLICT(slug) DO UPDATE SET label = $2`, [sk.slug, sk.label]);
  }
  const r = await pool.query("SELECT slug, label, filename, contract FROM pd_skills");
  r.rows.forEach((row) => {
    if (state.skills[row.slug]) {
      state.skills[row.slug].label = row.label || state.skills[row.slug].label;
      state.skills[row.slug].filename = row.filename || "";
      state.skills[row.slug].contract = row.contract || "";
    }
  });
}

async function saveSkillToDb(slug) {
  if (!pool) return;
  const s = state.skills[slug];
  if (!s) return;
  try {
    await pool.query(
      `INSERT INTO pd_skills(slug, label, filename, contract, updated_at)
       VALUES($1, $2, $3, $4, now())
       ON CONFLICT(slug) DO UPDATE SET label=$2, filename=$3, contract=$4, updated_at=now()`,
      [s.slug, s.label, s.filename, s.contract]);
  } catch (e) { console.error("saveSkillToDb:", e.message); }
}

// Extract plain text from an uploaded contract document.
async function extractText(filename, buf) {
  const ext = (filename || "").toLowerCase().split(".").pop();
  if (["txt", "md", "markdown", "text"].includes(ext)) return buf.toString("utf8");
  if (ext === "docx") {
    const mammoth = require("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value;
  }
  if (ext === "pdf") {
    const pdf = require("pdf-parse");
    const d = await pdf(buf);
    return d.text;
  }
  return buf.toString("utf8");
}

async function logMessage(interactionId, role, content, model) {
  if (!pool) return;
  try {
    await pool.query(
      "INSERT INTO pd_messages(interaction_id, role, content, model) VALUES($1, $2, $3, $4)",
      [interactionId, role, content, model || null]);
  } catch (e) { /* logging is best-effort */ }
}

// ===================== Firebase token minting =====================
async function mintIdToken(overrideToken, overrideApiKey) {
  const refreshToken = (overrideToken && overrideToken.trim()) || state.refreshToken;
  const apiKey = (overrideApiKey && overrideApiKey.trim()) || state.firebaseApiKey;
  // An ad-hoc token (e.g. from the admin "Detect" button, before Save) must never
  // be cached into or read from the persisted session state.
  const usingOverride = Boolean(overrideToken && overrideToken.trim() && overrideToken.trim() !== state.refreshToken);
  if (!refreshToken) throw new Error("No refresh token configured.");
  const now = Date.now();
  if (!usingOverride && state.idToken && state.idTokenExp - now > 120000) return { idToken: state.idToken, uid: state.uid };
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  const r = await fetch("https://securetoken.googleapis.com/v1/token?key=" + apiKey, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const d = await r.json();
  if (!d.id_token) throw new Error("Token refresh failed: " + JSON.stringify(d).slice(0, 200));
  if (!usingOverride) {
    state.idToken = d.id_token; state.uid = d.user_id;
    state.idTokenExp = now + parseInt(d.expires_in || "3600", 10) * 1000;
  }
  return { idToken: d.id_token, uid: d.user_id };
}

function restHeaders(idToken, uid) {
  return {
    accept: "*/*", "content-type": "application/json",
    origin: ORIGIN, referer: ORIGIN + "/", "user-agent": UA,
    "x-auth-key": uid, authorization: "Bearer " + idToken,
  };
}

function genId() {
  return crypto.randomBytes(16).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 22);
}

// ===================== Status & admin =====================
app.get("/api/status", (req, res) => {
  res.json({
    configured: Boolean(state.refreshToken),
    gummieId: state.gummieId,
    dbConnected: state.dbConnected,
    // Site keys must reach the browser to render the captcha widgets.
    turnstileSiteKey: state.turnstileSiteKey,
    hcaptchaSiteKey: state.hcaptchaSiteKey,
    // Firebase API key is NOT exposed (server-side only); report presence only.
    firebaseConfigured: Boolean(state.firebaseApiKey),
    port: state.port,
  });
});

// Save session + platform config. Blank fields are left unchanged.
app.post("/api/admin/creds", async (req, res) => {
  const b = req.body || {};
  if (!checkPassword(b.password)) return res.status(401).json({ error: "Invalid admin password." });

  if (typeof b.refreshToken === "string" && b.refreshToken.trim()) {
    state.refreshToken = b.refreshToken.trim(); state.idToken = ""; state.idTokenExp = 0;
  }
  if (typeof b.gummieId === "string" && b.gummieId.trim()) state.gummieId = b.gummieId.trim();
  if (typeof b.firebaseApiKey === "string" && b.firebaseApiKey.trim()) {
    state.firebaseApiKey = b.firebaseApiKey.trim(); state.idToken = ""; state.idTokenExp = 0;
  }
  if (typeof b.turnstileSiteKey === "string" && b.turnstileSiteKey.trim()) state.turnstileSiteKey = b.turnstileSiteKey.trim();
  if (typeof b.hcaptchaSiteKey === "string" && b.hcaptchaSiteKey.trim()) state.hcaptchaSiteKey = b.hcaptchaSiteKey.trim();

  let portChanged = false;
  if (b.port !== undefined && b.port !== null && String(b.port).trim()) {
    const np = parsePort(b.port, null);
    if (np === null) return res.status(400).json({ error: "Port must be an integer between 1 and 65535." });
    if (np !== state.port) portChanged = true;
    state.port = np;
  }

  // Apply the password change last so a bad value can't lock this request out.
  let passwordChanged = false;
  if (typeof b.newPassword === "string" && b.newPassword.trim()) {
    state.adminPassword = b.newPassword.trim(); passwordChanged = true;
  }

  await saveConfigToDb();
  res.json({
    ok: true,
    configured: Boolean(state.refreshToken),
    gummieId: state.gummieId,
    dbConnected: state.dbConnected,
    passwordChanged,
    portChanged,
    port: state.port,
  });
});

app.post("/api/admin/clear", (req, res) => {
  const { password } = req.body || {};
  if (!checkPassword(password)) return res.status(401).json({ error: "Invalid admin password." });
  state.refreshToken = ""; state.idToken = ""; state.idTokenExp = 0;
  res.json({ ok: true, configured: false });
});

app.post("/api/admin/verify", async (req, res) => {
  const { password } = req.body || {};
  if (!checkPassword(password)) return res.status(401).json({ error: "Invalid admin password." });
  try { const { uid } = await mintIdToken(); res.json({ ok: true, uid }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// List the account's agents so the admin can pick one instead of hunting for the ID.
app.post("/api/admin/agents", async (req, res) => {
  const { password, refreshToken, firebaseApiKey } = req.body || {};
  if (!checkPassword(password)) return res.status(401).json({ error: "Invalid admin password." });
  // Permit detecting with a freshly-extracted token that hasn't been saved yet,
  // falling back to the persisted session token. This handler never persists.
  const rt = (typeof refreshToken === "string" && refreshToken.trim()) || state.refreshToken;
  if (!rt) return res.status(400).json({ error: "Set a refresh token first, then detect agents." });
  try {
    const { idToken, uid } = await mintIdToken(rt, firebaseApiKey);
    const r = await fetch(API + "/gummies", { headers: restHeaders(idToken, uid) });
    const text = await r.text();
    if (!r.ok) return res.status(502).json({ error: "Upstream " + r.status + ": " + text.slice(0, 200) });
    let d; try { d = JSON.parse(text); } catch { d = {}; }
    const arr = Array.isArray(d) ? d : (d.data || d.gummies || d.results || d.items || []);
    const agents = arr.map((g) => ({
      id: g.gummie_id || g.id || g.gummieId || g._id || "",
      name: g.name || g.gummie_name || g.title || g.label || "(unnamed)",
    })).filter((a) => a.id);
    res.json({ agents });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ===================== Skills (working contracts) =====================
app.get("/api/skills", (req, res) => {
  const list = DEFAULT_SKILLS.map((d) => {
    const s = state.skills[d.slug];
    return { slug: s.slug, label: s.label, filename: s.filename || "", hasContract: Boolean(s.contract) };
  });
  res.json({ skills: list });
});

app.post("/api/admin/skill/get", (req, res) => {
  const { password, slug } = req.body || {};
  if (!checkPassword(password)) return res.status(401).json({ error: "Invalid admin password." });
  const s = state.skills[slug];
  if (!s) return res.status(404).json({ error: "Unknown skill." });
  res.json({ slug: s.slug, label: s.label, filename: s.filename || "", contract: s.contract || "" });
});

app.post("/api/admin/skill", async (req, res) => {
  const { password, slug, filename, text, contentBase64 } = req.body || {};
  if (!checkPassword(password)) return res.status(401).json({ error: "Invalid admin password." });
  const s = state.skills[slug];
  if (!s) return res.status(404).json({ error: "Unknown skill." });
  let contract = null;
  try {
    if (typeof text === "string" && text.trim()) {
      contract = text;
      if (filename) s.filename = filename;
    } else if (typeof contentBase64 === "string" && contentBase64) {
      const buf = Buffer.from(contentBase64, "base64");
      contract = (await extractText(filename || "", buf)).trim();
      s.filename = filename || s.filename;
    } else {
      return res.status(400).json({ error: "Provide a document file or contract text." });
    }
  } catch (e) {
    return res.status(400).json({ error: "Could not read the document: " + e.message });
  }
  if (!contract || !contract.trim()) return res.status(400).json({ error: "The document produced no readable text." });
  s.contract = contract;
  await saveSkillToDb(slug);
  res.json({ ok: true, slug: s.slug, label: s.label, filename: s.filename, hasContract: true, chars: contract.length });
});

// Recent logged messages (for a history view)
app.get("/api/messages", async (req, res) => {
  if (!pool) return res.json({ messages: [] });
  try {
    const r = await pool.query("SELECT interaction_id, role, content, model, created_at FROM pd_messages ORDER BY id DESC LIMIT 100");
    res.json({ messages: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===================== REST proxy =====================
app.all(/^\/api\/gl\/(.*)/, async (req, res) => {
  if (!state.refreshToken) return res.status(503).json({ error: "Not configured." });
  try {
    const { idToken, uid } = await mintIdToken();
    const rest = req.originalUrl.replace(/^\/api\/gl\//, "");
    const init = { method: req.method, headers: restHeaders(idToken, uid) };
    if (!["GET", "HEAD"].includes(req.method)) init.body = JSON.stringify(req.body || {});
    const r = await fetch(API + "/" + rest, init);
    const text = await r.text();
    res.status(r.status).set("content-type", r.headers.get("content-type") || "application/json").send(text);
  } catch (err) { res.status(502).json({ error: "Upstream failed: " + err.message }); }
});

// ===================== Send (manual-captcha, WebSocket) =====================
app.post("/api/send", async (req, res) => {
  if (!state.refreshToken) return res.status(503).json({ error: "Not configured." });
  const { message, interaction_id, turnstile_token, hcaptcha_token, skill } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: "message is required." });
  if (!turnstile_token) return res.status(400).json({ error: "Turnstile token required (solve the verification)." });
  if (!state.gummieId) return res.status(400).json({ error: "No gummie selected." });

  let idToken, uid;
  try { ({ idToken, uid } = await mintIdToken()); }
  catch (e) { return res.status(401).json({ error: e.message }); }

  const iid = (interaction_id && interaction_id.trim()) || genId();
  const isNew = !interaction_id;

  // On a NEW conversation, prepend the selected skill's working contract so the
  // agent operates under it as binding instructions for the whole conversation.
  let outgoing = message;
  const sk = skill && state.skills[skill];
  if (isNew && sk && sk.contract) {
    outgoing =
      `You are operating under a binding WORKING CONTRACT for this task — "${sk.label}". ` +
      `Treat every rule in it as authoritative for the entire conversation.\n\n` +
      `===== WORKING CONTRACT: ${sk.label} =====\n${sk.contract}\n===== END WORKING CONTRACT =====\n\n` +
      `User's request:\n${message}`;
  }

  const frame = {
    type: "start",
    payload: {
      id_token: idToken,
      context: {
        gummie_id: state.gummieId, interaction_id: iid,
        message: { id: "msg_" + genId(), timestamp: new Date().toISOString(),
                   content: outgoing, role: "user", creator_id: uid },
        type: "chat", is_incognito: false,
      },
      captcha_token: hcaptcha_token || "", captcha_provider: "hcaptcha", turnstile_token,
    },
  };

  const frames = [];
  let streamText = "";
  let wsError = null;

  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch {} resolve(); } };
    const timer = setTimeout(finish, 150000);
    const ws = new WebSocket(WS_URL, { origin: ORIGIN, headers: { "user-agent": UA } });
    ws.on("open", () => ws.send(JSON.stringify(frame)));
    ws.on("message", (data) => {
      const s = data.toString();
      frames.push(s.slice(0, 1500));
      try {
        const o = JSON.parse(s);
        if (o.type === "error") { wsError = o.errorMessage || o.error || "error"; clearTimeout(timer); finish(); return; }
        if (typeof o.text === "string") streamText += o.text;
        else if (typeof o.delta === "string") streamText += o.delta;
        // Only terminate on the END OF THE WHOLE TURN — NOT on "step-finish",
        // which fires after each intermediate step (e.g. a single tool call) and
        // would cut a multi-step agent off at its first action.
        if (["finish", "interaction-finish", "complete", "end"].includes(o.type)) { clearTimeout(timer); finish(); }
      } catch { /* non-json */ }
    });
    ws.on("error", (e) => { wsError = wsError || e.message; clearTimeout(timer); finish(); });
    ws.on("close", () => { clearTimeout(timer); finish(); });
  });

  if (wsError) return res.status(400).json({ error: wsError, frames, interaction_id: iid });

  let reply = streamText.trim();
  try {
    await new Promise((r) => setTimeout(r, 800));
    const r = await fetch(API + "/gummie_interactions/" + iid, { headers: restHeaders(idToken, uid) });
    if (r.ok) {
      const d = await r.json();
      const msgs = (d.interaction && d.interaction.messages) || [];
      const last = [...msgs].reverse().find((m) => m.role === "assistant");
      if (last) {
        const t = (last.parts || []).filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n");
        if (t) reply = t;
      }
    }
  } catch { /* keep streamText */ }

  logMessage(iid, "user", message, null);
  logMessage(iid, "assistant", reply, null);

  res.json({ interaction_id: iid, is_new: isNew, reply: reply || "(no text returned)", frames });
});

// Admin entry point.
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "admin.html")));

app.use(express.static(path.join(__dirname, "..", "public")));

// ===================== Boot =====================
async function start() {
  if (state.dbUrl) {
    try { await connectDb(state.dbUrl); console.log("Database connected; config loaded."); }
    catch (e) { console.error("Database connect failed:", e.message); }
  }
  app.listen(state.port, () => {
    console.log(`ProfessorDoom on http://localhost:${state.port}`);
    console.log(state.refreshToken ? "Refresh token loaded." : "No session — set it in /admin");
  });
}

start();
