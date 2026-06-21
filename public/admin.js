'use strict';

const $ = (id) => document.getElementById(id);
const statusline = $('statusline');
const noticeEl = $('notice');
const saveBtn = $('save');
const clearBtn = $('clear');

async function refreshStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    statusline.innerHTML = s.configured
      ? 'Status: <strong style="color:#7ee787">configured</strong>' +
        ' · cookie ' + (s.hasCookie ? 'set' : '<span style="color:#ff9aa0">missing</span>') +
        ' · gummie <code>' + (s.gummieId || '—') + '</code>' +
        ' · send ' + (s.sendConfigured ? '<code>' + s.sendMethod + ' ' + s.sendPath + '</code>' : '<span style="color:#ffcf7a">not set</span>')
      : 'Status: <strong style="color:#ff9aa0">not configured</strong> — no session yet.';
    if (s.gummieId) $('gummieId').placeholder = s.gummieId;
    if (s.sendPath) $('sendPath').placeholder = s.sendPath;
    if (s.sendMethod) $('sendMethod').placeholder = s.sendMethod;
  } catch {
    statusline.textContent = 'Status: server offline.';
  }
}

function notify(msg, ok) {
  noticeEl.textContent = msg;
  noticeEl.className = 'notice ' + (ok ? 'ok' : 'err');
}

async function save() {
  const password = $('password').value;
  if (!password) return notify('Enter the admin password.', false);
  const body = { password };
  const map = { authKey: 'authKey', cookie: 'cookie', gummieId: 'gummieId', userAgent: 'userAgent', sendPath: 'sendPath', sendMethod: 'sendMethod' };
  Object.entries(map).forEach(([k, id]) => { const v = $(id).value.trim(); if (v) body[k] = v; });
  // allow clearing sendPath explicitly
  if ($('sendPath').value === '' && $('sendPath').dataset.touched) body.sendPath = '';

  saveBtn.disabled = true;
  try {
    const r = await fetch('/api/admin/creds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) notify(data.error || 'Update failed.', false);
    else {
      notify('Saved. Session is ' + (data.configured ? 'configured.' : 'still missing an x-auth-key.'), true);
      $('authKey').value = ''; $('cookie').value = '';
      refreshStatus();
    }
  } catch { notify('Could not reach the server.', false); }
  finally { saveBtn.disabled = false; }
}

async function clearSession() {
  const password = $('password').value;
  if (!password) return notify('Enter the admin password to clear.', false);
  try {
    const r = await fetch('/api/admin/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    const data = await r.json();
    if (!r.ok) notify(data.error || 'Clear failed.', false);
    else { notify('Stored session cleared.', true); refreshStatus(); }
  } catch { notify('Could not reach the server.', false); }
}

$('sendPath').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
saveBtn.addEventListener('click', save);
clearBtn.addEventListener('click', clearSession);
refreshStatus();
