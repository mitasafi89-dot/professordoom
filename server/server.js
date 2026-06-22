'use strict';

/**
 * ProfessorDoom — custom UI over a Gumloop session, with Postgres persistence.
 *
 * Auth: a Firebase refresh token (project agenthub-dev), held server-side only.
 * The server mints short-lived id_tokens from it, proxies REST reads to
 * api.gumloop.com, and sends chat over wss://ws.gumloop.com/ws/gummies
 * (each message requires browser-solved Turnstile + hCaptcha tokens).
 *
 * Postgres (optional): persists the session config across restarts and logs
 * messages. Connection string is set via the admin dashboard or DATABASE_URL.
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '8mb' }));

const PORT = process.env.PORT || 3000;
const FIREBASE_API_KEY = 'AIzaSyCYuXqbJ0YBNltoGS4-7Y6Hozrra8KKmaE';
const API = 'https://api.gumloop.com';
const WS_URL = 'wss://ws.gumloop.com/ws/gummies';
const ORIGIN = 'https://www.gumloop.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

const state = {
  refreshToken: process.env.GUMLOOP_REFRESH_TOKEN || '',
  gummieId: process.env.GUMLOOP_GUMMIE_ID || '',
  idToken: '',
  uid: '',
  idTokenExp: 0,
  dbUrl: process.env.DATABASE_URL || '',
  dbConnected: false,
};

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
  await p.query('SELECT 1');
  await p.query(`CREATE TABLE IF NOT EXISTS pd_config (
    key text PRIMARY KEY, value text, updated_at timestamptz DEFAULT now())`);
  await p.query(`CREATE TABLE IF NOT EXISTS pd_messages (
    id bigserial PRIMARY KEY, interaction_id text, role text, content text,
    model text, created_at timestamptz DEFAULT now())`);
  if (pool) { try { await pool.end(); } catch {} }
  pool = p;
  state.dbUrl = url;
  state.dbConnected = true;
  await loadConfigFromDb();
}

async function loadConfigFromDb() {
  if (!pool) return;
  const r = await pool.query('SELECT key, value FROM pd_config');
  const m = {};
  r.rows.forEach((x) => { m[x.key] = x.value; });
  if (m.refresh_token && !state.refreshToken) {
    state.refreshToken = m.refresh_token; state.idToken = ''; state.idTokenExp = 0;
  }
  if (m.gummie_id && !state.gummieId) state.gummieId = m.gummie_id;
}

async function saveConfigToDb() {
  if (!pool) return;
  const up = (k, v) => pool.query(
    `INSERT INTO pd_config(key, value, updated_at) VALUES($1, $2, now())
     ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = now()`, [k, v]);
  try {
    if (state.refreshToken) await up('refresh_token', state.refreshToken);
    if (state.gummieId) await up('gummie_id', state.gummieId);
  } catch (e) { console.error('saveConfigToDb:', e.message); }
}

async function logMessage(interactionId, role, content, model) {
  if (!pool) return;
  try {
    await pool.query(
      'INSERT INTO pd_messages(interaction_id, role, content, model) VALUES($1, $2, $3, $4)',
      [interactionId, role, content, model || null]);
  } catch (e) { /* logging is best-effort */ }
}

// ===================== Firebase token minting =====================
async function mintIdToken() {
  if (!state.refreshToken) throw new Error('No refresh token configured.');
  const now = Date.now();
  if (state.idToken && state.idTokenExp - now > 120000) return { idToken: state.idToken, uid: state.uid };
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: state.refreshToken });
  const r = await fetch('https://securetoken.googleapis.com/v1/token?key=' + FIREBASE_API_KEY, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const d = await r.json();
  if (!d.id_token) throw new Error('Token refresh failed: ' + JSON.stringify(d).slice(0, 200));
  state.idToken = d.id_token; state.uid = d.user_id;
  state.idTokenExp = now + parseInt(d.expires_in || '3600', 10) * 1000;
  return { idToken: state.idToken, uid: state.uid };
}

function restHeaders(idToken, uid) {
  return {
    accept: '*/*', 'content-type': 'application/json',
    origin: ORIGIN, referer: ORIGIN + '/', 'user-agent': UA,
    'x-auth-key': uid, authorization: 'Bearer ' + idToken,
  };
}

function genId() {
  return crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 22);
}

// ===================== Status & admin =====================
app.get('/api/status', (req, res) => {
  res.json({
    configured: Boolean(state.refreshToken),
    gummieId: state.gummieId,
    dbConnected: state.dbConnected,
    turnstileSiteKey: '0x4AAAAAACMum7HpvvFmcf2r',
    hcaptchaSiteKey: '5dd279d6-b56e-4dec-b474-6426c2f83150',
  });
});

app.post('/api/admin/creds', async (req, res) => {
  const { password, refreshToken, gummieId } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid admin password.' });
  if (typeof refreshToken === 'string' && refreshToken.trim()) {
    state.refreshToken = refreshToken.trim(); state.idToken = ''; state.idTokenExp = 0;
  }
  if (typeof gummieId === 'string' && gummieId.trim()) state.gummieId = gummieId.trim();
  await saveConfigToDb();
  res.json({ ok: true, configured: Boolean(state.refreshToken), gummieId: state.gummieId, dbConnected: state.dbConnected });
});

app.post('/api/admin/clear', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid admin password.' });
  state.refreshToken = ''; state.idToken = ''; state.idTokenExp = 0;
  res.json({ ok: true, configured: false });
});

app.post('/api/admin/verify', async (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid admin password.' });
  try { const { uid } = await mintIdToken(); res.json({ ok: true, uid }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Connect / test the database
app.post('/api/admin/db', async (req, res) => {
  const { password, dbUrl } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid admin password.' });
  if (!dbUrl || !dbUrl.trim()) return res.status(400).json({ error: 'Connection string required.' });
  try {
    await connectDb(dbUrl.trim());
    await saveConfigToDb(); // persist whatever is currently in memory
    const c = await pool.query('SELECT count(*)::int AS n FROM pd_messages');
    res.json({ ok: true, dbConnected: true, messageCount: c.rows[0].n });
  } catch (e) {
    state.dbConnected = false;
    res.status(400).json({ error: 'DB connection failed: ' + e.message });
  }
});

// Recent logged messages (for a history view)
app.get('/api/messages', async (req, res) => {
  if (!pool) return res.json({ messages: [] });
  try {
    const r = await pool.query('SELECT interaction_id, role, content, model, created_at FROM pd_messages ORDER BY id DESC LIMIT 100');
    res.json({ messages: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===================== REST proxy =====================
app.all(/^\/api\/gl\/(.*)/, async (req, res) => {
  if (!state.refreshToken) return res.status(503).json({ error: 'Not configured.' });
  try {
    const { idToken, uid } = await mintIdToken();
    const rest = req.originalUrl.replace(/^\/api\/gl\//, '');
    const init = { method: req.method, headers: restHeaders(idToken, uid) };
    if (!['GET', 'HEAD'].includes(req.method)) init.body = JSON.stringify(req.body || {});
    const r = await fetch(API + '/' + rest, init);
    const text = await r.text();
    res.status(r.status).set('content-type', r.headers.get('content-type') || 'application/json').send(text);
  } catch (err) { res.status(502).json({ error: 'Upstream failed: ' + err.message }); }
});

// ===================== Send (manual-captcha, WebSocket) =====================
app.post('/api/send', async (req, res) => {
  if (!state.refreshToken) return res.status(503).json({ error: 'Not configured.' });
  const { message, interaction_id, turnstile_token, hcaptcha_token } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'message is required.' });
  if (!turnstile_token) return res.status(400).json({ error: 'Turnstile token required (solve the verification).' });
  if (!state.gummieId) return res.status(400).json({ error: 'No gummie selected.' });

  let idToken, uid;
  try { ({ idToken, uid } = await mintIdToken()); }
  catch (e) { return res.status(401).json({ error: e.message }); }

  const iid = (interaction_id && interaction_id.trim()) || genId();
  const isNew = !interaction_id;
  const frame = {
    type: 'start',
    payload: {
      id_token: idToken,
      context: {
        gummie_id: state.gummieId, interaction_id: iid,
        message: { id: 'msg_' + genId(), timestamp: new Date().toISOString(),
                   content: message, role: 'user', creator_id: uid },
        type: 'chat', is_incognito: false,
      },
      captcha_token: hcaptcha_token || '', captcha_provider: 'hcaptcha', turnstile_token,
    },
  };

  const frames = [];
  let streamText = '';
  let wsError = null;

  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch {} resolve(); } };
    const timer = setTimeout(finish, 150000);
    const ws = new WebSocket(WS_URL, { origin: ORIGIN, headers: { 'user-agent': UA } });
    ws.on('open', () => ws.send(JSON.stringify(frame)));
    ws.on('message', (data) => {
      const s = data.toString();
      frames.push(s.slice(0, 1500));
      try {
        const o = JSON.parse(s);
        if (o.type === 'error') { wsError = o.errorMessage || o.error || 'error'; clearTimeout(timer); finish(); return; }
        if (typeof o.text === 'string') streamText += o.text;
        else if (typeof o.delta === 'string') streamText += o.delta;
        if (['finish', 'step-finish', 'done', 'interaction-finish', 'complete', 'end'].includes(o.type)) { clearTimeout(timer); finish(); }
      } catch { /* non-json */ }
    });
    ws.on('error', (e) => { wsError = wsError || e.message; clearTimeout(timer); finish(); });
    ws.on('close', () => { clearTimeout(timer); finish(); });
  });

  if (wsError) return res.status(400).json({ error: wsError, frames, interaction_id: iid });

  let reply = streamText.trim();
  try {
    await new Promise((r) => setTimeout(r, 800));
    const r = await fetch(API + '/gummie_interactions/' + iid, { headers: restHeaders(idToken, uid) });
    if (r.ok) {
      const d = await r.json();
      const msgs = (d.interaction && d.interaction.messages) || [];
      const last = [...msgs].reverse().find((m) => m.role === 'assistant');
      if (last) {
        const t = (last.parts || []).filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n');
        if (t) reply = t;
      }
    }
  } catch { /* keep streamText */ }

  // Persist to DB (best-effort)
  logMessage(iid, 'user', message, null);
  logMessage(iid, 'assistant', reply, null);

  res.json({ interaction_id: iid, is_new: isNew, reply: reply || '(no text returned)', frames });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, async () => {
  console.log(`ProfessorDoom (Gumloop client) on http://localhost:${PORT}`);
  console.log(state.refreshToken ? 'Refresh token loaded from environment.' : 'No session — set it in /admin.html');
  if (state.dbUrl) {
    try { await connectDb(state.dbUrl); console.log('Database connected; config loaded.'); }
    catch (e) { console.error('Database connect failed:', e.message); }
  }
});
