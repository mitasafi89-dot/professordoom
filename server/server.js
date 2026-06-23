"use strict";

/**
 * ProfessorDoom, custom UI over a Gumloop session, with Postgres persistence.
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
const net = require("net");
const dns = require("dns").promises;
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

// ===================== Observability: errors + credits =====================
// A small in-memory ring buffer of the most recent failures coming back from
// Gumloop (auth, REST, WebSocket, no-output diagnostics, credit checks) so the
// UI can surface them instead of leaving the user in the dark.
state.recentErrors = [];
function recordError(source, message, code) {
  const entry = {
    ts: new Date().toISOString(),
    source: String(source || "unknown"),
    message: String(message == null ? "" : message).slice(0, 600),
    code: code == null ? null : code,
    // Flag the failures the user most needs to act on.
    credit: /credit|insufficient|quota|out of|exhaust|billing|payment|402/i.test(String(message || "")),
  };
  state.recentErrors.unshift(entry);
  if (state.recentErrors.length > 30) state.recentErrors.length = 30;
  return entry;
}

// Gumloop's credit endpoint shape isn't contractually fixed, so parse it
// defensively: scan top-level and one-nested-level numeric fields and match the
// usual key names, then derive whichever of used/limit/remaining is missing.
// Defensive fallback for an UNKNOWN credit payload shape: walk a few levels deep
// and match the usual key namings. Only used when the known fields are absent.
function genericCredits(raw) {
  const out = { used: null, limit: null, remaining: null, tier: null };
  if (!raw || typeof raw !== "object") return out;
  const flat = {};
  const add = (k, v) => {
    if (typeof v === "number" && isFinite(v)) flat[k.toLowerCase()] = v;
    else if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) flat[k.toLowerCase()] = Number(v);
  };
  const walk = (obj, prefix, depth) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || depth > 4) return;
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? prefix + "." + k : k;
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, key, depth + 1);
      else add(key, v);
      if (typeof v === "string" && /tier|plan/i.test(k) && !out.tier) out.tier = v;
    }
  };
  walk(raw, "", 0);
  const find = (...res) => {
    for (const re of res) for (const k of Object.keys(flat)) if (re.test(k)) return flat[k];
    return null;
  };
  out.limit = find(/(credit.*limit|limit.*credit|total.*credit|credit.*total|max.*credit|monthly.*credit|quota)/, /\blimit\b|\btotal\b|\bquota\b|\bcap\b/);
  out.used = find(/(credit.*used|used.*credit|consumed|credit.*consumed|credits?_?used|usage)/, /\bused\b|\bconsumed\b|\busage\b|\bspent\b/);
  out.remaining = find(/(remaining|credits?_?left|available|credit.*balance|\bbalance\b)/, /\bremaining\b|\bleft\b|\bavailable\b|\bbalance\b/);
  return out;
}

// Normalize Gumloop's credit response. The REAL shape (confirmed from a captured
// HAR) is { credit_limit, remaining, is_past_due, credit_overage_unavailable_reason,
// ... } with NO "used" field — used is derived as limit - remaining, and remaining
// can exceed the limit (overage/rollover). `restriction` is the optional
// /credit_restriction_details payload, the authoritative "blocked" signal.
function normalizeCredits(raw, restriction) {
  const out = { used: null, limit: null, remaining: null, tier: null,
                pastDue: false, restricted: false, restrictionReason: null, raw: raw };
  const num = (v) => (typeof v === "number" && isFinite(v)) ? v
    : (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : null);
  if (raw && typeof raw === "object") {
    out.limit = num(raw.credit_limit);
    out.remaining = num(raw.remaining);
    out.pastDue = raw.is_past_due === true;
    if (typeof raw.credit_overage_unavailable_reason === "string" && raw.credit_overage_unavailable_reason.trim())
      out.restrictionReason = raw.credit_overage_unavailable_reason;
    if (typeof raw.subscription_tier === "string") out.tier = raw.subscription_tier;
    // Fall back to the generic matcher only for fields the known shape didn't fill.
    if (out.limit == null || out.remaining == null || out.tier == null) {
      const g = genericCredits(raw);
      if (out.limit == null) out.limit = g.limit;
      if (out.remaining == null) out.remaining = g.remaining;
      if (out.used == null) out.used = g.used;
      if (out.tier == null) out.tier = g.tier;
    }
  }
  if (restriction && typeof restriction === "object") {
    out.restricted = restriction.has_restriction === true;
    if (restriction.credit_restriction && !out.restrictionReason) out.restrictionReason = String(restriction.credit_restriction);
    if (out.remaining == null) out.remaining = num(restriction.remaining);
  }
  if (out.remaining == null && out.limit != null && out.used != null) out.remaining = out.limit - out.used;
  if (out.used == null && out.limit != null && out.remaining != null) out.used = Math.max(0, out.limit - out.remaining);
  out.exhausted = out.remaining != null ? out.remaining <= 0
    : (out.limit != null && out.used != null ? out.used >= out.limit : false);
  // What the UI should treat as "cannot run": no credits, an active restriction,
  // or a past-due account.
  out.blocked = out.exhausted || out.restricted || out.pastDue;
  return out;
}



let creditCache = { ts: 0, data: null };
const CREDIT_CACHE_MS = parseInt(process.env.CREDIT_CACHE_MS || "", 10) >= 0
  ? parseInt(process.env.CREDIT_CACHE_MS, 10) : 15000;

// Is an admin password actually enforced? Only when one is configured.
function adminAuthRequired() {
  return Boolean(state.adminPassword && state.adminPassword.length);
}

// Constant-time admin password check (avoids timing leaks).
// When no admin password is configured, the dashboard is OPEN and every check
// passes, so the user is never asked for a password (autonomous default).
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
  try {
  await p.query("SELECT 1");
  await p.query(`CREATE TABLE IF NOT EXISTS pd_config (
    key text PRIMARY KEY, value text, updated_at timestamptz DEFAULT now())`);
  await p.query(`CREATE TABLE IF NOT EXISTS pd_messages (
    id bigserial PRIMARY KEY, interaction_id text, role text, content text,
    model text, created_at timestamptz DEFAULT now())`);
  await p.query(`CREATE TABLE IF NOT EXISTS pd_skills (
    slug text PRIMARY KEY, label text, filename text, contract text,
    updated_at timestamptz DEFAULT now())`);
  // Processed deliverables (manuscript, figures, references, ...) captured as the
  // agent exports them, stored durably so they stay downloadable/previewable.
  await p.query(`CREATE TABLE IF NOT EXISTS pd_documents (
    id text PRIMARY KEY, interaction_id text, conversation_name text,
    filename text, media_type text, artifact_url text, bytes bigint,
    version int DEFAULT 1, content bytea,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
  } catch (e) {
    // Never leak the freshly-created pool when the connect or DDL fails; the
    // previously-connected pool (if any) is left intact for fallback.
    try { await p.end(); } catch {}
    throw e;
  }
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

// ===================== Processed-document persistence =====================
// As the agent exports deliverables (file artifacts) after each phase, capture
// the bytes and store them durably (Postgres bytea, size-capped) so they remain
// downloadable/previewable even after the upstream artifact URL expires, and
// accumulate into a per-conversation library. Falls back to an in-memory store
// when no database is connected (lost on restart, fine for local/dev use).
const MAX_DOC_BYTES = 25 * 1024 * 1024; // store inline up to 25MB; larger -> metadata + live URL only
const memDocs = new Map(); // id -> full doc (fallback when no DB)

function docId(iid, filename) {
  return crypto.createHash("sha1").update(String(iid) + "|" + String(filename))
    .digest("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 22);
}
async function docUpsert(doc) {
  const bytes = doc.content ? doc.content.length : 0;
  if (pool) {
    await pool.query(
      `INSERT INTO pd_documents(id, interaction_id, conversation_name, filename, media_type, artifact_url, bytes, content, version, created_at, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,now(),now())
       ON CONFLICT (id) DO UPDATE SET conversation_name=$3, media_type=$5, artifact_url=$6,
         bytes=$7, content=$8, version=pd_documents.version+1, updated_at=now()`,
      [doc.id, doc.interaction_id, doc.conversation_name || null, doc.filename,
       doc.media_type || null, doc.artifact_url || null, bytes, doc.content || null]);
  } else {
    const prev = memDocs.get(doc.id);
    memDocs.set(doc.id, { ...doc, bytes, version: prev ? prev.version + 1 : 1,
      created_at: prev ? prev.created_at : new Date().toISOString(), updated_at: new Date().toISOString() });
  }
}
async function docMeta(id) {
  if (pool) {
    const r = await pool.query("SELECT id, interaction_id, filename, media_type, artifact_url, bytes FROM pd_documents WHERE id=$1", [id]);
    return r.rows[0] || null;
  }
  const d = memDocs.get(id); if (!d) return null;
  const { content, ...meta } = d; return meta;
}
async function docList(iid) {
  if (pool) {
    const params = []; let where = "";
    if (iid) { where = "WHERE interaction_id=$1"; params.push(iid); }
    const r = await pool.query(
      `SELECT id, interaction_id, conversation_name, filename, media_type, artifact_url, bytes, version, created_at, updated_at
       FROM pd_documents ${where} ORDER BY updated_at DESC LIMIT 200`, params);
    return r.rows;
  }
  let rows = [...memDocs.values()].map(({ content, ...m }) => m);
  if (iid) rows = rows.filter((d) => d.interaction_id === iid);
  rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return rows;
}
async function docFetch(id) {
  if (pool) {
    const r = await pool.query("SELECT id, filename, media_type, artifact_url, content FROM pd_documents WHERE id=$1", [id]);
    const row = r.rows[0]; if (!row) return null;
    return { ...row, content: row.content ? Buffer.from(row.content) : null };
  }
  return memDocs.get(id) || null;
}
// Capture every file artifact in a finished turn's parts[]. Best-effort and
// idempotent: a filename re-exported with the SAME url is skipped; a new version
// (new url) replaces the stored bytes and bumps the version.
async function persistDocuments(iid, convName, parts) {
  if (!Array.isArray(parts)) return;
  for (const p of parts) {
    if (!p || p.type !== "file" || !p.file || !p.file.artifact_url) continue;
    const f = p.file;
    const name = String(f.filename || "file").split("/").pop();
    const url = f.artifact_url;
    const id = docId(iid, name);
    try {
      const existing = await docMeta(id);
      if (existing && existing.artifact_url === url) continue;
      // allowlist + SSRF + redirect-safe + size-capped. Cap at the inline limit:
      // anything larger is stored as metadata + the live URL, never buffered whole.
      const r = await fetchArtifact(url, { maxBytes: MAX_DOC_BYTES });
      if (r.error === "too-large") {
        await docUpsert({ id, interaction_id: iid, conversation_name: convName, filename: name,
          media_type: f.media_type || null, artifact_url: url, content: null });
        continue;
      }
      if (r.error || !r.ok) { recordError("documents", "fetch " + name + " -> " + (r.error || ("HTTP " + r.status)), r.status); continue; }
      const ctype = r.ctype || f.media_type || "application/octet-stream";
      await docUpsert({ id, interaction_id: iid, conversation_name: convName, filename: name,
        media_type: f.media_type || ctype, artifact_url: url, content: r.buf });
    } catch (e) { recordError("documents", "persist " + name + ": " + e.message); }
  }
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

// Live Gumloop credit usage/limit. Cached briefly so the polling UI doesn't
// hammer the upstream. Records a structured error (and reports it) on failure.
app.get("/api/credits", async (req, res) => {
  if (!state.refreshToken) return res.status(503).json({ error: "Not configured." });
  const now = Date.now();
  if (creditCache.data && now - creditCache.ts < CREDIT_CACHE_MS) return res.json(creditCache.data);
  try {
    const { idToken, uid } = await mintIdToken();
    const qs = "?user_id=" + encodeURIComponent(uid);
    // The credit endpoint REQUIRES user_id (confirmed from the captured HAR).
    // Fetch the restriction details in parallel for the authoritative block signal.
    const [r, rr] = await Promise.all([
      fetch(API + "/get_subscription_tier_credit_limit" + qs, { headers: restHeaders(idToken, uid) }),
      fetch(API + "/user/" + encodeURIComponent(uid) + "/credit_restriction_details", { headers: restHeaders(idToken, uid) }).catch(() => null),
    ]);
    const text = await r.text();
    let raw = null; try { raw = JSON.parse(text); } catch {}
    if (!r.ok) {
      const msg = "Credit check failed (HTTP " + r.status + ")" + (text ? ": " + text.slice(0, 200) : "");
      recordError("credits", msg, r.status);
      return res.status(502).json({ error: msg, status: r.status });
    }
    let restriction = null;
    if (rr && rr.ok) { try { restriction = JSON.parse(await rr.text()); } catch {} }
    const data = normalizeCredits(raw, restriction);
    creditCache = { ts: now, data };
    res.json(data);
  } catch (e) {
    recordError("credits", e.message);
    res.status(502).json({ error: "Credit check failed: " + e.message });
  }
});

// Recent Gumloop-side errors (auth / REST / WebSocket / no-output / credits).
app.get("/api/errors", (req, res) => {
  res.json({ errors: state.recentErrors, count: state.recentErrors.length });
});
app.post("/api/errors/clear", (req, res) => {
  state.recentErrors = [];
  res.json({ ok: true });
});

// ===================== Processed documents =====================
// List stored deliverables (metadata only). ?interaction_id=... filters to one
// conversation; omit it for the whole library.
app.get("/api/documents", async (req, res) => {
  try {
    const iid = String(req.query.interaction_id || "").trim() || null;
    res.json({ documents: await docList(iid) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Serve a stored deliverable from the database (durable). ?dl=1 forces download;
// ?as=html renders a Word doc to HTML for inline preview. Falls back to proxying
// the live artifact URL for documents too large to store inline.
app.get("/api/documents/:id", async (req, res) => {
  try {
    const doc = await docFetch(String(req.params.id));
    if (!doc) return res.status(404).json({ error: "Document not found." });
    const name = (String(doc.filename || "document").split("/").pop() || "document").replace(/[\r\n"\\]/g, "");
    const wantHtml = req.query.as === "html";
    const wantDownload = req.query.dl === "1";
    if (!doc.content) {
      if (!doc.artifact_url) return res.status(410).json({ error: "Document content unavailable." });
      return res.redirect(302, "/api/file?url=" + encodeURIComponent(doc.artifact_url) + "&name=" + encodeURIComponent(name) +
        (wantHtml ? "&as=html" : "") + (wantDownload ? "&dl=1" : ""));
    }
    const buf = doc.content;
    const ctype = doc.media_type || "application/octet-stream";
    return serveDocumentBuffer(res, buf, name, ctype, { wantHtml, wantDownload });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Current non-secret config, so the admin form can REPOPULATE on load.
// This is why a refresh no longer looks like it "wiped" your settings, the
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
  // dbConnected lets the chat UI tell "DB not connected" apart from "no contract
  // uploaded", otherwise a disconnected DB looks like a missing contract.
  try { res.json({ skills: await getSkillsList(), dbConnected: state.dbConnected }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Connect this server to Supabase/Postgres at RUNTIME (no shell/env needed) and
// persist the connection string so it survives restarts. This is what makes the
// stored skills/contracts actually load, without a connection the server falls
// back to empty in-memory defaults and every skill shows "no contract uploaded".
app.post("/api/admin/database", async (req, res) => {
  const { password, url } = req.body || {};
  if (!checkPassword(password)) return res.status(401).json({ error: "Invalid admin password." });
  if (!url || !url.trim()) return res.status(400).json({ error: "Connection string is required." });
  try {
    await connectDb(url.trim());          // sets state.dbUrl + state.dbConnected, loads config + skills
    saveStateToFile();                    // persist so the connection survives a restart
    const skills = await getSkillsList();
    const withContract = skills.filter((s) => s.hasContract).length;
    res.json({ ok: true, dbConnected: state.dbConnected, skillCount: skills.length, withContract, skills });
  } catch (e) {
    state.dbConnected = false;
    res.status(400).json({ error: "Could not connect: " + e.message });
  }
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
  } catch (err) { recordError("rest", err.message); res.status(502).json({ error: "Upstream failed: " + err.message }); }
});

// ===================== Autonomous-mode directive =====================
// Autonomous-mode directive: appended (via the existing injection path) when the
// browser has Auto-continue enabled. It teaches the agent the turn protocol so
// the client can reliably detect completion vs. a genuine question for the user.
const AUTOCONTINUE_DIRECTIVE =
  '[AUTONOMOUS MODE] You are running without a human pressing "continue" between turns. ' +
  'Work straight through the ENTIRE task across as many turns as needed, always resuming exactly where you left off. ' +
  'Do NOT stop to ask whether you should continue, and do NOT end a turn with offers like "want me to proceed?". ' +
  // Anti-stall: the most common failure in long runs is re-announcing the same
  // next step ("Now I\u2019m writing the manuscript\u2026") turn after turn without ever
  // doing it. Every turn must change the world, not just describe intent.
  'NEVER end a turn that made no concrete progress. Each turn must either (i) make a real tool call that ' +
  'creates or changes a file/artifact, or (ii) deliver new written output. Do NOT spend a turn merely restating ' +
  'what you are "about to" do \u2014 if you are about to write something, write it in THIS turn. Never repeat the ' +
  'same "next I will\u2026" sentence across turns; if the same step keeps recurring, you are stalling \u2014 just execute it. ' +
  // Deliverable handoff: files that live only in the sandbox are invisible to
  // the user. Anything they must read/download has to be exported as an artifact.
  'Any file the user must see (manuscript, figures, tables, datasets, cover letter, checklist) MUST be exported as a ' +
  'downloadable artifact via sandbox_download \u2014 a file that exists only inside the sandbox has NOT been delivered. ' +
  'Before emitting the completion token, confirm every deliverable has been exported and is downloadable. ' +
  'Stop only when ONE of these is true: (a) the whole task is genuinely complete AND all deliverables are exported \u2014 ' +
  'then end your FINAL message with the exact token \u27e6TASK_COMPLETE\u27e7 on its own line; or (b) you truly need a ' +
  'decision or information from the user before you can proceed \u2014 then ask via the ask_human_input tool and do ' +
  'NOT emit the completion token.';

// ===================== Send (STREAMING, Server-Sent Events) =====================
// Streams the agent's turn to the browser LIVE. Every Gumloop WS frame is
// forwarded as an SSE `frame` event so reasoning, tool steps, and text deltas
// appear as they happen, instead of the browser blocking until the whole turn
// finishes. A final `done` event carries the authoritative REST parts[] for an
// exact re-render. The conversation (interaction_id) persists across turns just
// as before; this only changes HOW the turn is delivered.
app.post("/api/send/stream", async (req, res) => {
  const { message, interaction_id, turnstile_token, hcaptcha_token, skill, reinject, autocontinue, attachments } = req.body || {};
  if (!state.refreshToken) return res.status(503).json({ error: "Not configured." });
  if (!message || !message.trim()) return res.status(400).json({ error: "message is required." });
  if (!turnstile_token) return res.status(400).json({ error: "Turnstile token required (solve the verification)." });
  if (!state.gummieId) return res.status(400).json({ error: "No gummie selected." });

  let idToken, uid;
  try { ({ idToken, uid } = await mintIdToken()); }
  catch (e) { recordError("auth", e.message); return res.status(401).json({ error: e.message }); }

  // SSE headers, open a persistent, unbuffered event stream to the browser.
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
      `You are operating under a binding WORKING CONTRACT for this task: "${sk.label}". ` +
      `Treat every rule in it as authoritative for the entire conversation.\n\n` +
      `===== WORKING CONTRACT: ${sk.label} =====\n${sk.contract}\n===== END WORKING CONTRACT =====\n\n` +
      `User's request:\n${message}`;
  }
  // Append any user-uploaded files, extracted to plain text (docx/pdf/txt/…).
  if (Array.isArray(attachments) && attachments.length) {
    const blocks = [];
    for (const a of attachments) {
      try {
        const buf = Buffer.from((a && a.contentBase64) || "", "base64");
        const text = (await extractText((a && a.filename) || "", buf)).trim();
        if (text) blocks.push(`----- ATTACHED FILE: ${(a && a.filename) || "file"} -----\n${text}`);
      } catch (e) { /* skip unreadable attachment */ }
    }
    if (blocks.length) outgoing += `\n\nThe user attached the following file(s):\n\n${blocks.join("\n\n")}`;
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
  let closeInfo = null;     // {code, reason} from the upstream WS close
  let restStatus = 0;       // HTTP status of the REST reconciliation read
  let sawAnyFrame = false;  // did Gumloop send us ANY frame at all?
  const ws = new WebSocket(WS_URL, { origin: ORIGIN, headers: { "user-agent": UA } });

  const finishUp = async () => {
    if (closed) return; closed = true;
    clearInterval(heartbeat);
    clearTimeout(timer);
    try { ws.close(); } catch {}
    // REST reconciliation, the authoritative final parts for an exact re-render.
    let reply = streamText.trim();
    let parts = null;
    let convName = null;
    try {
      await new Promise((r) => setTimeout(r, 600));
      const rr = await fetch(API + "/gummie_interactions/" + iid, { headers: restHeaders(idToken, uid) });
      restStatus = rr.status;
      if (rr.ok) {
        const d = await rr.json();
        convName = (d.interaction && d.interaction.name) || null;
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
    const hasParts = Array.isArray(parts) && parts.length > 0;
    const noOutput = !hasParts && !reply;

    // Turn the silent "(no text returned)" into an actionable diagnostic so the
    // real failure (auth / wrong Agent ID / localhost captcha) is visible.
    let diagnostic = "";
    if (noOutput) {
      if (wsError) {
        diagnostic = "Upstream rejected the message: " + wsError +
          (/captcha|turnstile|hcaptcha/i.test(wsError) ? " \u2014 verification tokens are NOT valid on localhost; serve the app from a real host/domain." : "");
      } else if (restStatus === 401 || restStatus === 403) {
        diagnostic = "No output, and the conversation could not be read back (HTTP " + restStatus +
          "). The configured Agent ID likely isn\u2019t accessible by the connected account, or the session token is invalid/expired. In /admin, re-paste your auth blob and confirm the Agent ID belongs to that same account.";
      } else if (closeInfo && closeInfo.code === 1008) {
        diagnostic = "The server rejected the message (close 1008) \u2014 almost always an invalid verification token. hCaptcha/Turnstile do not issue valid tokens on localhost; serve the app from a real host/domain and retry.";
      } else if (closeInfo && closeInfo.code && closeInfo.code !== 1000) {
        diagnostic = "The connection closed (code " + closeInfo.code + (closeInfo.reason ? ": " + closeInfo.reason : "") + ") before the agent produced any text.";
      } else if (!sawAnyFrame) {
        diagnostic = "The agent stream produced no frames at all. Check the session (Agent ID + auth blob) in /admin and that the app is served from a non-localhost host.";
      } else {
        diagnostic = "The agent produced no text for this turn. If it repeats, re-check the session in /admin and serve from a non-localhost host so verification tokens are accepted.";
      }
    }
    if (wsError) { recordError("send", wsError, closeInfo && closeInfo.code); sse("error", { error: wsError }); }
    else if (noOutput) { recordError("send", diagnostic, restStatus || (closeInfo && closeInfo.code)); sse("error", { error: diagnostic }); }
    // Persist any deliverables this turn produced (fire-and-forget; never blocks done).
    if (Array.isArray(parts) && parts.length) persistDocuments(iid, convName, parts).catch(() => {});
    sse("done", { interaction_id: iid, is_new: isNew, reply: reply || diagnostic || "(no text returned)", parts, pending, complete, diagnostic });
    try { res.end(); } catch {}
  };

  const timer = setTimeout(finishUp, 150000);
  ws.on("open", () => ws.send(JSON.stringify(frame)));
  ws.on("message", (data) => {
    sawAnyFrame = true;
    const s = data.toString();
    let o = null; try { o = JSON.parse(s); } catch {}
    if (o) {
      // Gumloop signals failures in a few shapes \u2014 catch them all.
      if (o.type === "error" || o.type === "interaction-error" || o.error || o.errorMessage) {
        wsError = o.errorMessage || o.error || (typeof o.message === "string" ? o.message : "") || "upstream error";
        return finishUp();
      }
      if (typeof o.text === "string") streamText += o.text;
      else if (typeof o.delta === "string") streamText += o.delta;
      sse("frame", o);
      // Terminate only on the END OF THE WHOLE TURN, never on per-step frames.
      if (["finish", "interaction-finish", "complete", "end"].includes(o.type)) return finishUp();
    } else {
      sse("frame", { raw: s.slice(0, 2000) });
    }
  });
  ws.on("error", (e) => { wsError = wsError || e.message; finishUp(); });
  ws.on("close", (code, reason) => { closeInfo = { code, reason: (reason && reason.toString) ? reason.toString() : "" }; finishUp(); });
  // If the browser navigates away or hits Stop, tear the upstream WS down.
  req.on("close", () => { if (!closed) { closed = true; clearInterval(heartbeat); clearTimeout(timer); try { ws.close(); } catch {} } });
});

// ===================== File proxy (download + preview) =====================
// Streams a Gumloop artifact back through THIS origin so the browser can
// (a) force a real download with the correct filename + content-type
// (format preserved), and (b) preview it inline without cross-origin or
// X-Frame-Options friction. ?dl=1 -> attachment; ?as=html -> Word doc rendered
// to HTML via mammoth for a faithful in-app preview.
// Send a document buffer to the client. When as=html is requested for a Word
// doc, render it to HTML via mammoth for a faithful inline preview; otherwise
// stream the bytes inline (preview) or as an attachment (dl=1). Shared by
// /api/documents/:id (stored bytes) and /api/file (proxied live artifact).
async function serveDocumentBuffer(res, buf, name, ctype, { wantHtml, wantDownload }) {
  if (wantHtml && (/wordprocessingml|officedocument\.word|msword/i.test(ctype) || /\.docx?$/i.test(name))) {
    try {
      const mammoth = require("mammoth");
      const { value: html } = await mammoth.convertToHtml({ buffer: buf });
      res.set("content-type", "text/html; charset=utf-8");
      res.set("cache-control", "private, max-age=300");
      return res.send(html || "<p><em>Empty document.</em></p>");
    } catch (e) { return res.status(415).json({ error: "Could not render document: " + e.message }); }
  }
  res.set("content-type", ctype);
  res.set("cache-control", "private, max-age=300");
  res.set("x-content-type-options", "nosniff");
  // Inline so PDFs/text/images render in the preview panel; attachment forces a save.
  res.set("content-disposition", (wantDownload ? "attachment" : "inline") + '; filename="' + name + '"');
  return res.send(buf);
}

// ---- Artifact fetching: host allowlist + redirect/size caps ----
// /api/file must only proxy real Gumloop artifact hosts, never act as an open
// egress proxy for arbitrary URLs. Hosts are suffix-matched (so subdomains and
// the gumloop.com -> storage.googleapis.com signed-URL hop are covered).
// Override for self-hosting via PD_ARTIFACT_HOSTS (comma-separated).
const ARTIFACT_HOST_SUFFIXES = (process.env.PD_ARTIFACT_HOSTS || "gumloop.com,storage.googleapis.com")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const MAX_FILE_BYTES = (() => {
  const n = parseInt(process.env.PD_MAX_FILE_BYTES || "", 10);
  return Number.isInteger(n) && n > 0 ? n : 50 * 1024 * 1024; // 50MB default
})();
const MAX_REDIRECT_HOPS = 5;
function hostAllowed(host) {
  host = String(host || "").toLowerCase();
  return ARTIFACT_HOST_SUFFIXES.some((suf) => host === suf || host.endsWith("." + suf));
}

// True if an IP literal is loopback, link-local, private, or otherwise not a
// globally-routable address we should let the server fetch on a client's behalf.
function isPrivateIp(ip) {
  if (!ip) return true;
  let s = String(ip).toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) -> evaluate the embedded IPv4.
  const mapped = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) s = mapped[1];
  if (net.isIPv4(s)) {
    const [a, b] = s.split(".").map(Number);
    return (
      a === 0 ||                       // 0.0.0.0/8 "this network"
      a === 10 ||                      // 10/8 private
      a === 127 ||                     // 127/8 loopback
      (a === 169 && b === 254) ||      // 169.254/16 link-local (cloud metadata)
      (a === 172 && b >= 16 && b <= 31) || // 172.16/12 private
      (a === 192 && b === 168) ||      // 192.168/16 private
      (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
      (a === 192 && b === 0) ||        // 192.0.0/24 + 192.0.2/24 reserved
      (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
      a >= 224                          // 224+ multicast / reserved
    );
  }
  if (net.isIPv6(s)) {
    return (
      s === "::" || s === "::1" ||     // unspecified / loopback
      s.startsWith("fe8") || s.startsWith("fe9") ||
      s.startsWith("fea") || s.startsWith("feb") || // fe80::/10 link-local
      s.startsWith("fc") || s.startsWith("fd") ||    // fc00::/7 unique-local
      s.startsWith("ff")                             // ff00::/8 multicast
    );
  }
  return true; // unknown literal form -> fail closed
}

// Validate an artifact URL before the server fetches it, to prevent SSRF. We
// resolve the hostname via DNS and reject if ANY resolved address is private /
// loopback / link-local (a hostname-string check alone is bypassable by a name
// that resolves to 127.0.0.1 or 169.254.169.254). Returns the URL string when
// safe, otherwise null. Fails closed on resolution errors.
async function safeArtifactUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // The allowlist is ALWAYS enforced, so /api/file can never become an open
  // egress proxy for arbitrary URLs -- even when SSRF checks are bypassed.
  if (!hostAllowed(host)) return null;
  // PD_ALLOW_LOCAL_FETCH skips ONLY the private-IP/DNS SSRF check, for local
  // test mocks and self-hosted artifact hosts on a private network.
  if (process.env.PD_ALLOW_LOCAL_FETCH === "1") return u.toString();
  if (host === "localhost") return null;
  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      const recs = await dns.lookup(host, { all: true });
      addresses = recs.map((r) => r.address);
    } catch { return null; }   // unresolvable -> reject
    if (!addresses.length) return null;
  }
  if (addresses.some(isPrivateIp)) return null;
  return u.toString();
}

// Fetch a Gumloop artifact safely: validate the URL (allowlist + SSRF) on EVERY
// hop -- redirect:"manual" with per-hop re-validation, so a 302 cannot bounce us
// onto a private/loopback or off-allowlist target -- and cap the buffered size
// to avoid OOM. The legit gumloop.com -> storage.googleapis.com signed-URL hop
// is followed because both hosts are allowlisted. Returns { ok, status, ctype,
// buf } on success or { error, status } on a blocked/oversize/redirect failure.
async function fetchArtifact(rawUrl, { maxBytes = MAX_FILE_BYTES } = {}) {
  let url = await safeArtifactUrl(rawUrl);
  if (!url) return { error: "blocked", status: 400 };
  let resp = null;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    resp = await fetch(url, { redirect: "manual", headers: { "user-agent": UA } });
    if (resp.status < 300 || resp.status >= 400) break; // not a redirect
    const loc = resp.headers.get("location");
    if (!loc) break;
    try { await resp.body?.cancel?.(); } catch {}
    if (hop === MAX_REDIRECT_HOPS) return { error: "too many redirects", status: 502 };
    try { url = await safeArtifactUrl(new URL(loc, url).toString()); } catch { url = null; }
    if (!url) return { error: "redirect to a disallowed host", status: 400 };
  }
  const ctype = resp.headers.get("content-type") || "application/octet-stream";
  const declared = parseInt(resp.headers.get("content-length") || "", 10);
  if (Number.isInteger(declared) && declared > maxBytes) return { error: "too-large", status: 413 };
  const chunks = []; let total = 0;
  if (resp.body) {
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { try { await reader.cancel(); } catch {} return { error: "too-large", status: 413 }; }
      chunks.push(Buffer.from(value));
    }
  }
  return { ok: resp.ok, status: resp.status, ctype, buf: Buffer.concat(chunks) };
}

app.get("/api/file", async (req, res) => {
  const wantHtml = req.query.as === "html";
  const wantDownload = req.query.dl === "1";
  const name = (String(req.query.name || "document").split("/").pop() || "document").replace(/[\r\n"\\]/g, "");
  try {
    const r = await fetchArtifact(String(req.query.url || ""));
    if (r.error === "blocked") return res.status(400).json({ error: "Bad or missing file url." });
    if (r.error === "too-large") return res.status(413).json({ error: "File exceeds the maximum proxy size." });
    if (r.error) return res.status(r.status).json({ error: r.error });
    if (!r.ok) return res.status(r.status).json({ error: "Upstream returned " + r.status });
    return serveDocumentBuffer(res, r.buf, name, r.ctype, { wantHtml, wantDownload });
  } catch (err) {
    res.status(502).json({ error: "Fetch failed: " + err.message });
  }
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
  server = app.listen(state.port, () => {
    console.log(`ProfessorDoom on http://localhost:${state.port}`);
    console.log(state.refreshToken ? "Refresh token loaded." : "No session yet. Set it in /admin");
  });
}

// Graceful shutdown: stop accepting connections and close the Postgres pool so a
// redeploy/restart doesn't drop in-flight requests or leak DB connections.
let server = null;
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  const force = setTimeout(() => process.exit(0), 8000);
  force.unref();
  try { if (server) await new Promise((r) => server.close(r)); } catch {}
  try { if (pool) await pool.end(); } catch {}
  clearTimeout(force);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start();
