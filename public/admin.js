'use strict';

const $ = (id) => document.getElementById(id);
const statusline = $('statusline');
const noticeEl = $('notice');

async function refreshStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    statusline.innerHTML = s.configured
      ? 'Status: <strong style="color:#7ee787">configured</strong> · gummie <code>' + (s.gummieId || '—') + '</code>'
      : 'Status: <strong style="color:#ff9aa0">not configured</strong> — no refresh token set.';
    if (s.gummieId) $('gummieId').placeholder = s.gummieId;
    $('dbStatus').innerHTML = s.dbConnected
      ? 'Database: <strong style="color:#7ee787">connected</strong>'
      : 'Database: <strong style="color:#ffcf7a">not connected</strong> — config is in-memory only.';
  } catch {
    statusline.textContent = 'Status: server offline.';
  }
}

function dbNotify(msg, ok) {
  const el = $('dbNotice');
  el.textContent = msg; el.className = 'notice ' + (ok ? 'ok' : 'err');
}

async function connectDb() {
  const password = $('password').value;
  if (!password) return dbNotify('Enter the admin password.', false);
  const dbUrl = $('dbUrl').value.trim();
  if (!dbUrl) return dbNotify('Paste a connection string.', false);
  $('connectDb').disabled = true;
  dbNotify('Connecting…', true);
  try {
    const { ok, data } = await post('/api/admin/db', { password, dbUrl });
    if (!ok) dbNotify(data.error || 'Connection failed.', false);
    else { dbNotify('✓ Connected. ' + (data.messageCount ?? 0) + ' messages logged. Config persisted.', true); $('dbUrl').value = ''; refreshStatus(); }
  } catch { dbNotify('Could not reach the server.', false); }
  finally { $('connectDb').disabled = false; }
}

function notify(msg, ok) {
  noticeEl.textContent = msg;
  noticeEl.className = 'notice ' + (ok ? 'ok' : 'err');
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let data = {}; try { data = await r.json(); } catch {}
  return { ok: r.ok, data };
}

async function save() {
  const password = $('password').value;
  if (!password) return notify('Enter the admin password.', false);
  const body = { password };
  const rt = $('refreshToken').value.trim();
  const gid = $('gummieId').value.trim();
  if (rt) body.refreshToken = rt;
  if (gid) body.gummieId = gid;
  $('save').disabled = true;
  try {
    const { ok, data } = await post('/api/admin/creds', body);
    if (!ok) notify(data.error || 'Update failed.', false);
    else { notify('Saved. Session is ' + (data.configured ? 'configured.' : 'still missing a refresh token.'), true); $('refreshToken').value = ''; refreshStatus(); }
  } catch { notify('Could not reach the server.', false); }
  finally { $('save').disabled = false; }
}

async function verify() {
  const password = $('password').value;
  if (!password) return notify('Enter the admin password to verify.', false);
  notify('Minting a token…', true);
  const { ok, data } = await post('/api/admin/verify', { password });
  if (ok) notify('✓ Session works. Authenticated as uid ' + data.uid, true);
  else notify('Verify failed: ' + (data.error || 'unknown'), false);
}

async function clearSession() {
  const password = $('password').value;
  if (!password) return notify('Enter the admin password to clear.', false);
  const { ok, data } = await post('/api/admin/clear', { password });
  if (ok) { notify('Stored session cleared.', true); refreshStatus(); }
  else notify(data.error || 'Clear failed.', false);
}

$('save').addEventListener('click', save);
$('verify').addEventListener('click', verify);
$('clear').addEventListener('click', clearSession);
$('connectDb').addEventListener('click', connectDb);
refreshStatus();
