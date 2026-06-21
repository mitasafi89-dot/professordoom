'use strict';

/**
 * ProfessorDoom — a custom UI over a Gumloop session.
 *
 * The back-engine is the user's own Gumloop account. The admin pastes their
 * Gumloop session credentials (x-auth-key + session cookie) into the admin
 * dashboard. This server holds them in memory ONLY and transparently proxies
 * the browser's calls to https://api.gumloop.com, injecting the credentials.
 * The frontend therefore speaks the exact Gumloop API and never sees the secrets.
 */

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '8mb' }));

const PORT = process.env.PORT || 3000;
const GL_BASE = 'https://api.gumloop.com';
const GL_ORIGIN = 'https://www.gumloop.com';
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

// ---- Session credentials, held server-side only ----
const state = {
  authKey: process.env.GUMLOOP_AUTH_KEY || '', // x-auth-key (your user id)
  cookie: process.env.GUMLOOP_COOKIE || '',     // full session cookie string
  gummieId: process.env.GUMLOOP_GUMMIE_ID || '', // which agent to drive
  userAgent: process.env.GUMLOOP_UA || DEFAULT_UA,
  // Send-message request is captured per-deployment (not in the sample HAR).
  // Configure via the admin dashboard once you capture it from DevTools.
  sendMethod: process.env.GUMLOOP_SEND_METHOD || 'POST',
  sendPath: process.env.GUMLOOP_SEND_PATH || '', // e.g. gummies/{gummieId}/start
};

function glHeaders() {
  const h = {
    accept: '*/*',
    'content-type': 'application/json',
    origin: GL_ORIGIN,
    referer: GL_ORIGIN + '/',
    'user-agent': state.userAgent,
  };
  if (state.authKey) h['x-auth-key'] = state.authKey;
  if (state.cookie) h['cookie'] = state.cookie;
  return h;
}

// ---- Status (never leaks secret values) ----
app.get('/api/status', (req, res) => {
  res.json({
    configured: Boolean(state.authKey),
    hasCookie: Boolean(state.cookie),
    gummieId: state.gummieId,
    sendConfigured: Boolean(state.sendPath),
    sendMethod: state.sendMethod,
    sendPath: state.sendPath,
  });
});

// ---- Admin: set session credentials ----
app.post('/api/admin/creds', (req, res) => {
  const { password, authKey, cookie, gummieId, userAgent, sendPath, sendMethod } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password.' });
  }
  if (typeof authKey === 'string' && authKey.trim()) state.authKey = authKey.trim();
  if (typeof cookie === 'string' && cookie.trim()) state.cookie = cookie.trim();
  if (typeof gummieId === 'string' && gummieId.trim()) state.gummieId = gummieId.trim();
  if (typeof userAgent === 'string' && userAgent.trim()) state.userAgent = userAgent.trim();
  if (typeof sendPath === 'string') state.sendPath = sendPath.trim();
  if (typeof sendMethod === 'string' && sendMethod.trim()) state.sendMethod = sendMethod.trim().toUpperCase();
  res.json({ ok: true, configured: Boolean(state.authKey), gummieId: state.gummieId });
});

app.post('/api/admin/clear', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid admin password.' });
  state.authKey = '';
  state.cookie = '';
  res.json({ ok: true, configured: false });
});

// ---- Convenience: which gummie are we driving ----
app.get('/api/gummie', (req, res) => res.json({ gummieId: state.gummieId }));

// ---- Transparent proxy to api.gumloop.com (injects credentials) ----
// Any browser call to /api/gl/<path>?<query> is forwarded to GL_BASE/<path>?<query>.
app.all(/^\/api\/gl\/(.*)/, async (req, res) => {
  if (!state.authKey) {
    return res.status(503).json({ error: 'Not configured. An admin must paste Gumloop session credentials in the dashboard.' });
  }
  const rest = req.originalUrl.replace(/^\/api\/gl\//, '');
  const url = GL_BASE + '/' + rest;
  const init = { method: req.method, headers: glHeaders() };
  if (!['GET', 'HEAD'].includes(req.method)) {
    init.body = JSON.stringify(req.body || {});
  }
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    res.status(r.status);
    res.set('content-type', r.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: 'Upstream Gumloop request failed: ' + err.message });
  }
});

// ---- Send a message (uses the admin-configured send endpoint) ----
app.post('/api/send', async (req, res) => {
  if (!state.authKey) return res.status(503).json({ error: 'Not configured.' });
  if (!state.sendPath) {
    return res.status(501).json({
      error:
        'Send endpoint not configured. Capture a "send message" request in DevTools and set its path/method in the admin dashboard (e.g. gummies/{gummieId}/start).',
    });
  }
  const pathResolved = state.sendPath.replace('{gummieId}', state.gummieId);
  const url = GL_BASE + '/' + pathResolved.replace(/^\//, '');
  try {
    const r = await fetch(url, {
      method: state.sendMethod,
      headers: glHeaders(),
      body: JSON.stringify(req.body || {}),
    });
    const text = await r.text();
    res.status(r.status);
    res.set('content-type', r.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: 'Send failed: ' + err.message });
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`ProfessorDoom (Gumloop client) on http://localhost:${PORT}`);
  console.log(state.authKey ? 'Session loaded from environment.' : 'No session yet — set it in /admin.html');
});
