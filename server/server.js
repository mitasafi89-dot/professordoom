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
const fs = require("fs");
const crypto = require("crypto");
const WebSocket = require("ws");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "8mb" }));

// Gumloop endpoints. Overridable via env for self-hosting and for E2E tests
// (a mock Gumloop server can stand in for all three).
const API = process.env.GUMLOOP_API_URL || "https://api.gumloop.com";
const WS_URL = process.env.GUMLOOP_WS_URL || "wss://ws.gumloop.com/ws/gummies";
const TOKEN_URL = process.env.FIREBASE_TOKEN_URL || "https://securetoken.googleapis.com/v1/token";
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
  // Admin password is OPTIONAL. When empty, the admin dashboard is open and no
  // password is ever requested (the autonomous default). It only existed to stop
  // a random visitor to /admin from changing your Gumloop session; set one via
  // /admin (or ADMIN_PASSWORD) only if this instance is publicly reachable.
  adminPassword: process.env.ADMIN_PASSWORD || "",
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

// Is an admin password actually enforced? Only when one is configured.
function adminAuthRequired() {
  return Boolean(state.adminPassword && state.adminPassword.length);
}

// Constant-time admin password check (avoids timing leaks).
// When no admin password is configured, the dashboard is OPEN and every check
// passes — so the user is never asked for a password (autonomous default).
function checkPassword(p) {
  if (!adminAuthRequired()) return true;
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

// ===================== Local-file fallback persistence =====================
// Supabase/Postgres is the source of truth when DATABASE_URL is set. But to make
// the system fully autonomous, config + skills also persist to a local JSON file,
// so a restart NEVER wipes settings even if the database is unreachable or unset.
const LOCAL_STORE = process.env.PD_STATE_FILE || path.join(__dirname, ".pd-state.json");

function saveStateToFile() {
  try {
    const snapshot = {
      refreshToken: state.refreshToken,
      gummieId: state.gummieId,
      adminPassword: state.adminPassword,
      firebaseApiKey: state.firebaseApiKey,
      turnstileSiteKey: state.turnstileSiteKey,
      hcaptchaSiteKey: state.hcaptchaSiteKey,
      port: state.port,
      dbUrl: state.dbUrl,
      skills: state.skills,
    };
    fs.writeFileSync(LOCAL_STORE, JSON.stringify(snapshot, null, 2));
  } catch (e) { console.error("saveStateToFile:", e.message); }
}

function loadStateFromFile() {
  try {
    if (!fs.existsSync(LOCAL_STORE)) return;
    const m = JSON.parse(fs.readFileSync(LOCAL_STORE, "utf8")) || {};
    if (m.refreshToken) state.refreshToken = m.refreshToken;
    if (m.gummieId) state.gummieId = m.gummieId;
    if (typeof m.adminPassword === "string") state.adminPassword = m.adminPassword;
    if (m.firebaseApiKey) state.firebaseApiKey = m.firebaseApiKey;
    if (m.turnstileSiteKey) state.turnstileSiteKey = m.turnstileSiteKey;
    if (m.hcaptchaSiteKey) state.hcaptchaSiteKey = m.hcaptchaSiteKey;
    if (m.port) state.port = parsePort(m.port, state.port);
    if (m.dbUrl && !state.dbUrl) state.dbUrl = m.dbUrl;
    if (m.skills && typeof m.skills === "object") {
      for (const slug of Object.keys(m.skills)) {
        const row = m.skills[slug] || {};
        state.skills[slug] = {
          slug,
          label: row.label || (state.skills[slug] && state.skills[slug].label) || slug,
          filename: row.filename || "",
          contract: row.contract || "",
        };
      }
    }
  } catch (e) { console.error("loadStateFromFile:", e.message); }
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
  // Always mirror to the local file so settings persist with or without a DB.
  saveStateToFile();
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
  // Supabase is the source of truth for skills: load EVERY row, including any
  // skills that were added beyond the built-in defaults.
  r.rows.forEach((row) => {
    const existing = state.skills[row.slug] || { slug: row.slug };
    state.skills[row.slug] = {
      slug: row.slug,
      label: row.label || existing.label || row.slug,
      filename: row.filename || "",
      contract: row.contract || "",
    };
  });
}

// Read the current skill list straight from Supabase (falls back to in-memory
// state / local file when no DB is connected). This is what both the chat
// composer and the admin dashboard render, so skills are always DB-driven.
async function getSkillsList() {
  if (pool) {
    try {
      const r = await pool.query(
        "SELECT slug, label, filename, contract FROM pd_skills ORDER BY label");
      if (r.rows.length) {
        // Keep in-memory state in sync so /api/send can read contracts.
        r.rows.forEach((row) => {
          state.skills[row.slug] = {
            slug: row.slug,
            label: row.label || row.slug,
            filename: row.filename || "",
            contract: row.contract || "",
          };
        });
        return r.rows.map((row) => ({
          slug: row.slug,
          label: row.label || row.slug,
          filename: row.filename || "",
          hasContract: Boolean(row.contract),
        }));
      }
    } catch (e) { console.error("getSkillsList:", e.message); }
  }
  return Object.values(state.skills).map((s) => ({
    slug: s.slug, label: s.label, filename: s.filename || "", hasContract: Boolean(s.contract),
  }));
}

async function saveSkillToDb(slug) {
  // Mirror skills to the local file too, so contracts survive a DB outage.
  saveStateToFile();
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
  const r = await fetch(TOKEN_URL + "?key=" + apiKey, {
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
    // The UI uses this to hide the password field entirely when it's not enforced.
    adminAuthRequired: adminAuthRequired(),
  });
});

// Current non-secret config, so the admin form can REPOPULATE on load.
// This is why a refresh no longer looks like it "wiped" your settings — the
// stored values are shown right back to you.
app.get("/api/admin/config", (req, res) => {
  res.json({
    gummieId: state.gummieId,
    refreshTokenConfigured: Boolean(state.refreshToken),
    firebaseConfigured: Boolean(state.firebaseApiKey),
    turnstileSiteKey: state.turnstileSiteKey,
    hcaptchaSiteKey: state.hcaptchaSiteKey,
    port: state.port,
    dbConnected: state.dbConnected,
    adminAuthRequired: adminAuthRequired(),
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

// Parse a Firebase auth blob (the firebase:authUser:... value from browser
// storage) into { refreshToken, apiKey }. Accepts JSON or loose text.
function parseAuthBlob(raw) {
  let apiKey = "", refreshToken = "";
  if (!raw || typeof raw !== "string") return { apiKey, refreshToken };
  raw = raw.trim();
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
  return { apiKey: apiKey.trim(), refreshToken: refreshToken.trim() };
}

// ===================== Autonomous setup (paste blob -> done) =====================
// One call does EVERYTHING: extract the refresh token + API key from the blob,
// mint a token, auto-detect the account's agents, auto-select the Agent ID (the
// only agent, or the first), and persist it all. No "Detect" button, no Agent ID
// typing. If several agents exist, the token is still saved and the list is
// returned so the user can switch agents, but a default is already chosen.
app.post("/api/admin/blob", async (req, res) => {
  const b = req.body || {};
  if (!checkPassword(b.password)) return res.status(401).json({ error: "Invalid admin password." });

  // Accept either a raw blob or already-extracted fields.
  let refreshToken = (typeof b.refreshToken === "string" && b.refreshToken.trim()) || "";
  let apiKey = (typeof b.firebaseApiKey === "string" && b.firebaseApiKey.trim()) || "";
  if (b.blob) {
    const parsed = parseAuthBlob(b.blob);
    refreshToken = refreshToken || parsed.refreshToken;
    apiKey = apiKey || parsed.apiKey;
  }
  if (!refreshToken) {
    return res.status(400).json({ error: "Couldn't find a refresh token in that blob. Paste the full firebase:authUser:... value." });
  }

  // Mint a token (using the freshly-extracted creds, NOT the persisted ones) and
  // list the account's agents.
  let agents = [];
  let detectError = "";
  try {
    const { idToken, uid } = await mintIdToken(refreshToken, apiKey);
    const r = await fetch(API + "/gummies", { headers: restHeaders(idToken, uid) });
    const text = await r.text();
    if (!r.ok) {
      detectError = "Upstream " + r.status + ": " + text.slice(0, 160);
    } else {
      let d; try { d = JSON.parse(text); } catch { d = {}; }
      const arr = Array.isArray(d) ? d : (d.data || d.gummies || d.results || d.items || []);
      agents = arr.map((g) => ({
        id: g.gummie_id || g.id || g.gummieId || g._id || "",
        name: g.name || g.gummie_name || g.title || g.label || "(unnamed)",
      })).filter((a) => a.id);
    }
  } catch (e) {
    return res.status(400).json({ error: "Token from blob didn't work: " + e.message });
  }

  // Persist everything now: token, API key (if present), and the chosen agent.
  state.refreshToken = refreshToken;
  state.idToken = ""; state.idTokenExp = 0;
  if (apiKey) state.firebaseApiKey = apiKey;
  let selectedAgent = "";
  if (agents.length) {
    // Keep the current agent if it's still valid; otherwise pick the first.
    selectedAgent = agents.some((a) => a.id === state.gummieId) ? state.gummieId : agents[0].id;
    state.gummieId = selectedAgent;
  }
  await saveConfigToDb();

  res.json({
    ok: true,
    configured: Boolean(state.refreshToken),
    apiKeyDetected: Boolean(apiKey),
    agents,
    gummieId: state.gummieId,
    selectedAgent,
    dbConnected: state.dbConnected,
    detectError,
  });
});

// ===================== Skills (working contracts) =====================
// Skills are fetched live from Supabase (see getSkillsList).
app.get("/api/skills", async (req, res) => {
  try { res.json({ skills: await getSkillsList() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/skill/get", async (req, res) => {
  const { password, slug } = req.body || {};
  if (!checkPassword(password)) return res.status(401).json({ error: "Invalid admin password." });
  // Prefer the freshest copy from Supabase.
  if (pool) {
    try {
      const r = await pool.query(
        "SELECT slug, label, filename, contract FROM pd_skills WHERE slug = $1", [slug]);
      if (r.rows[0]) {
        const row = r.rows[0];
        state.skills[slug] = { slug: row.slug, label: row.label || slug, filename: row.filename || "", contract: row.contract || "" };
        return res.json({ slug: row.slug, label: row.label || slug, filename: row.filename || "", contract: row.contract || "" });
      }
    } catch (e) { /* fall through to memory */ }
  }
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
// Autonomous-mode directive: appended (via the existing injection path) when the
// browser has Auto-continue enabled. It teaches the agent the turn protocol so
// the client can reliably detect completion vs. a genuine question for the user.
const AUTOCONTINUE_DIRECTIVE =
  '[AUTONOMOUS MODE] You are running without a human pressing "continue" between turns. ' +
  'Work straight through the ENTIRE task across as many turns as needed, always resuming exactly where you left off. ' +
  'Do NOT stop to ask whether you should continue, and do NOT end a turn with offers like "want me to proceed?". ' +
  'Stop only when ONE of these is true: (a) the whole task is genuinely complete \u2014 then end your FINAL message ' +
  'with the exact token \u27e6TASK_COMPLETE\u27e7 on its own line; or (b) you truly need a decision or information ' +
  'from the user before you can proceed \u2014 then ask via the ask_human_input tool and do NOT emit the completion token.';

app.post("/api/send", async (req, res) => {
  if (!state.refreshToken) return res.status(503).json({ error: "Not configured." });
  const { message, interaction_id, turnstile_token, hcaptcha_token, skill, reinject, autocontinue } = req.body || {};
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
  // Inject the working contract on a NEW conversation, or on demand when the
  // user re-applies a skill mid-conversation (reinject).
  if ((isNew || reinject) && sk && sk.contract) {
    outgoing =
      `You are operating under a binding WORKING CONTRACT for this task — "${sk.label}". ` +
      `Treat every rule in it as authoritative for the entire conversation.\n\n` +
      `===== WORKING CONTRACT: ${sk.label} =====\n${sk.contract}\n===== END WORKING CONTRACT =====\n\n` +
      `User's request:\n${message}`;
  }
  if (autocontinue) outgoing = AUTOCONTINUE_DIRECTIVE + "\n\n" + outgoing;

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

// ===================== Send (STREAMING, Server-Sent Events) =====================
// Streams the agent's turn to the browser LIVE. Every Gumloop WS frame is
// forwarded as an SSE `frame` event so reasoning, tool steps, and text deltas
// appear as they happen — instead of the browser blocking until the whole turn
// finishes. A final `done` event carries the authoritative REST parts[] for an
// exact re-render. The conversation (interaction_id) persists across turns just
// as before; this only changes HOW the turn is delivered.
app.post("/api/send/stream", async (req, res) => {
  const { message, interaction_id, turnstile_token, hcaptcha_token, skill, reinject, autocontinue } = req.body || {};
  if (!state.refreshToken) return res.status(503).json({ error: "Not configured." });
  if (!message || !message.trim()) return res.status(400).json({ error: "message is required." });
  if (!turnstile_token) return res.status(400).json({ error: "Turnstile token required (solve the verification)." });
  if (!state.gummieId) return res.status(400).json({ error: "No gummie selected." });

  let idToken, uid;
  try { ({ idToken, uid } = await mintIdToken()); }
  catch (e) { return res.status(401).json({ error: e.message }); }

  // SSE headers — open a persistent, unbuffered event stream to the browser.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable proxy buffering (nginx) so frames flush live
  });
  const sse = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };
  const heartbeat = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15000);

  const iid = (interaction_id && interaction_id.trim()) || genId();
  const isNew = !interaction_id;
  sse("start", { interaction_id: iid, is_new: isNew });

  // On a NEW conversation, prepend the selected skill's working contract.
  let outgoing = message;
  const sk = skill && state.skills[skill];
  // Inject the working contract on a NEW conversation, or on demand when the
  // user re-applies a skill mid-conversation (reinject).
  if ((isNew || reinject) && sk && sk.contract) {
    outgoing =
      `You are operating under a binding WORKING CONTRACT for this task — "${sk.label}". ` +
      `Treat every rule in it as authoritative for the entire conversation.\n\n` +
      `===== WORKING CONTRACT: ${sk.label} =====\n${sk.contract}\n===== END WORKING CONTRACT =====\n\n` +
      `User's request:\n${message}`;
  }
  if (autocontinue) outgoing = AUTOCONTINUE_DIRECTIVE + "\n\n" + outgoing;

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

  let streamText = "";
  let wsError = null;
  let closed = false;
  const ws = new WebSocket(WS_URL, { origin: ORIGIN, headers: { "user-agent": UA } });

  const finishUp = async () => {
    if (closed) return; closed = true;
    clearInterval(heartbeat);
    clearTimeout(timer);
    try { ws.close(); } catch {}
    // REST reconciliation — the authoritative final parts for an exact re-render.
    let reply = streamText.trim();
    let parts = null;
    try {
      await new Promise((r) => setTimeout(r, 600));
      const rr = await fetch(API + "/gummie_interactions/" + iid, { headers: restHeaders(idToken, uid) });
      if (rr.ok) {
        const d = await rr.json();
        const msgs = (d.interaction && d.interaction.messages) || [];
        const last = [...msgs].reverse().find((m) => m.role === "assistant");
        if (last) {
          parts = last.parts || null;
          const t = (last.parts || []).filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n");
          if (t) reply = t;
        }
      }
    } catch { /* keep streamText */ }
    logMessage(iid, "user", message, null);
    logMessage(iid, "assistant", reply, null);
    const pending = Array.isArray(parts) && parts.some((p) => p && p.type === "tool_invocation" && p.toolName === "ask_human_input");
    const complete = /\u27e6TASK_COMPLETE\u27e7/.test(reply);
    if (wsError) sse("error", { error: wsError });
    sse("done", { interaction_id: iid, is_new: isNew, reply: reply || "(no text returned)", parts, pending, complete });
    try { res.end(); } catch {}
  };

  const timer = setTimeout(finishUp, 150000);
  ws.on("open", () => ws.send(JSON.stringify(frame)));
  ws.on("message", (data) => {
    const s = data.toString();
    let o = null; try { o = JSON.parse(s); } catch {}
    if (o) {
      if (o.type === "error") { wsError = o.errorMessage || o.error || "error"; return finishUp(); }
      if (typeof o.text === "string") streamText += o.text;
      else if (typeof o.delta === "string") streamText += o.delta;
      sse("frame", o);
      // Terminate only on the END OF THE WHOLE TURN — never on per-step frames.
      if (["finish", "interaction-finish", "complete", "end"].includes(o.type)) return finishUp();
    } else {
      sse("frame", { raw: s.slice(0, 2000) });
    }
  });
  ws.on("error", (e) => { wsError = wsError || e.message; finishUp(); });
  ws.on("close", () => finishUp());
  // If the browser navigates away or hits Stop, tear the upstream WS down.
  req.on("close", () => { if (!closed) { closed = true; clearInterval(heartbeat); clearTimeout(timer); try { ws.close(); } catch {} } });
});

// Admin entry point.
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "admin.html")));

app.use(express.static(path.join(__dirname, "..", "public")));

// ===================== Boot =====================
async function start() {
  // Load any locally-persisted settings first so a restart never loses config,
  // even when the database is unset or temporarily unreachable.
  loadStateFromFile();
  if (state.dbUrl) {
    try { await connectDb(state.dbUrl); console.log("Database connected; config loaded (Supabase is source of truth)."); }
    catch (e) { console.error("Database connect failed; using local persisted config:", e.message); }
  }
  app.listen(state.port, () => {
    console.log(`ProfessorDoom on http://localhost:${state.port}`);
    console.log(state.refreshToken ? "Refresh token loaded." : "No session — set it in /admin");
  });
}

start();
