'use strict';

/**
 * ProfessorDoom — custom UI over a Gumloop session.
 *
 * Auth: a Firebase refresh token (project agenthub-dev), held server-side only.
 * The server mints short-lived id_tokens from it on demand, uses them to
 *   - proxy REST reads to api.gumloop.com, and
 *   - send chat messages over wss://ws.gumloop.com/ws/gummies.
 *
 * Sending requires per-message bot-verification tokens (Cloudflare Turnstile +
 * hCaptcha) that ONLY a real browser can produce. The frontend renders those
 * widgets, the user solves them, and the tokens are forwarded in the WS frame.
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

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
  idTokenExp: 0, // epoch ms
};

// ---- Mint / cache a Firebase id_token from the refresh token ----
async function mintIdToken() {
  if (!state.refreshToken) throw new Error('No refresh token configured.');
  const now = Date.now();
  if (state.idToken && state.idTokenExp - now > 120000) {
    return { idToken: state.idToken, uid: state.uid };
  }
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: state.refreshToken });
  const r = await fetch('https://securetoken.googleapis.com/v1/token?key=' + FIREBASE_API_KEY, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const d = await r.json();
  if (!d.id_token) throw new Error('Token refresh failed: ' + JSON.stringify(d).slice(0, 200));
  state.idToken = d.id_token;
  state.uid = d.user_id;
  state.idTokenExp = now + parseInt(d.expires_in || '3600', 10) * 1000;
  return { idToken: state.idToken, uid: state.uid };
}

function restHeaders(idToken, uid) {
  return {
    accept: '*/*',
    'content-type': 'application/json',
    origin: ORIGIN,
    referer: ORIGIN + '/',
    'user-agent': UA,
    'x-auth-key': uid,
    authorization: 'Bearer ' + idToken,
  };
}

function genId() {
  // 22-char url-safe id (nanoid-ish)
  return crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 22);
}

// ---- Status ----
app.get('/api/status', (req, res) => {
  res.json({
    configured: Boolean(state.refreshToken),
    gummieId: state.gummieId,
    turnstileSiteKey: '0x4AAAAAACMum7HpvvFmcf2r',
    hcaptchaSiteKey: '5dd279d6-b56e-4dec-b474-6426c2f83150',
  });
});

// ---- Admin: set refresh token + gummie ----
app.post('/api/admin/creds', (req, res) => {
  const { password, refreshToken, gummieId } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid admin password.' });
  if (typeof refreshToken === 'string' && refreshToken.trim()) {
    state.refreshToken = refreshToken.trim();
    state.idToken = ''; state.idTokenExp = 0; // force re-mint
  }
  if (typeof gummieId === 'string' && gummieId.trim()) state.gummieId = gummieId.trim();
  res.json({ ok: true, configured: Boolean(state.refreshToken), gummieId: state.gummieId });
});

app.post('/api/admin/clear', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid admin password.' });
  state.refreshToken = ''; state.idToken = ''; state.idTokenExp = 0;
  res.json({ ok: true, configured: false });
});

// ---- Verify the session works (mints a token live) ----
app.post('/api/admin/verify', async (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid admin password.' });
  try {
    const { uid } = await mintIdToken();
    res.json({ ok: true, uid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Transparent REST proxy to api.gumloop.com ----
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
  } catch (err) {
    res.status(502).json({ error: 'Upstream failed: ' + err.message });
  }
});

// ---- Send a chat message over the WebSocket (manual-captcha) ----
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
        gummie_id: state.gummieId,
        interaction_id: iid,
        message: {
          id: 'msg_' + genId(),
          timestamp: new Date().toISOString(),
          content: message,
          role: 'user',
          creator_id: uid,
        },
        type: 'chat',
        is_incognito: false,
      },
      captcha_token: hcaptcha_token || '',
      captcha_provider: 'hcaptcha',
      turnstile_token,
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
        if (['finish', 'step-finish', 'done', 'interaction-finish', 'complete', 'end'].includes(o.type)) {
          clearTimeout(timer); finish();
        }
      } catch { /* non-json frame */ }
    });
    ws.on('error', (e) => { wsError = wsError || e.message; clearTimeout(timer); finish(); });
    ws.on('close', () => { clearTimeout(timer); finish(); });
  });

  if (wsError) {
    return res.status(400).json({ error: wsError, frames, interaction_id: iid });
  }

  // Authoritative final assistant text via REST (avoids guessing delta frame shape)
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

  res.json({ interaction_id: iid, is_new: isNew, reply: reply || '(no text returned)', frames });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`ProfessorDoom (Gumloop client) on http://localhost:${PORT}`);
  console.log(state.refreshToken ? 'Refresh token loaded from environment.' : 'No session — set it in /admin.html');
});
