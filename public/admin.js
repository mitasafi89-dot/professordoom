'use strict';

const statusline = document.getElementById('statusline');
const noticeEl = document.getElementById('notice');
const saveBtn = document.getElementById('save');

async function refreshStatus() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    statusline.innerHTML = s.configured
      ? 'Status: <strong style="color:#7ee787">configured</strong> · model <code>' + s.model + '</code> · max ' + s.maxTokens + ' tokens'
      : 'Status: <strong style="color:#ff9aa0">not configured</strong> — no token set yet.';
    if (s.model) document.getElementById('model').placeholder = s.model;
    if (s.maxTokens) document.getElementById('maxTokens').placeholder = s.maxTokens;
  } catch (e) {
    statusline.textContent = 'Status: server offline.';
  }
}

function notify(msg, ok) {
  noticeEl.textContent = msg;
  noticeEl.className = 'notice ' + (ok ? 'ok' : 'err');
}

async function save() {
  const password = document.getElementById('password').value;
  const token = document.getElementById('token').value;
  const model = document.getElementById('model').value.trim();
  const maxTokens = document.getElementById('maxTokens').value.trim();

  if (!password) return notify('Enter the admin password.', false);
  if (!token && !model && !maxTokens) return notify('Nothing to update.', false);

  saveBtn.disabled = true;
  try {
    const body = { password };
    if (token) body.token = token;
    if (model) body.model = model;
    if (maxTokens) body.maxTokens = Number(maxTokens);

    const r = await fetch('/api/admin/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      notify(data.error || 'Update failed.', false);
    } else {
      notify('Saved. Back-engine is ' + (data.configured ? 'configured.' : 'still missing a token.'), true);
      document.getElementById('token').value = '';
      refreshStatus();
    }
  } catch (e) {
    notify('Could not reach the server.', false);
  } finally {
    saveBtn.disabled = false;
  }
}

saveBtn.addEventListener('click', save);
refreshStatus();
