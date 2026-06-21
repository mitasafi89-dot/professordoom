'use strict';

const messagesEl = document.getElementById('messages');
const emptyEl = document.getElementById('empty');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const bannerEl = document.getElementById('banner');
const dotEl = document.getElementById('dot');
const statusTextEl = document.getElementById('statusText');

const history = []; // [{role, content}]
let busy = false;

// ---- Status check ----
async function refreshStatus() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    if (s.configured) {
      dotEl.className = 'status-dot on';
      statusTextEl.textContent = s.model || 'ready';
      bannerEl.classList.remove('show');
    } else {
      dotEl.className = 'status-dot off';
      statusTextEl.textContent = 'not configured';
      bannerEl.classList.add('show');
    }
  } catch (e) {
    dotEl.className = 'status-dot off';
    statusTextEl.textContent = 'offline';
  }
}

// ---- Lightweight markdown: bold, code, paragraphs ----
function render(text) {
  const esc = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = esc
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  return inline
    .split(/\n{2,}/)
    .map((p) => '<p>' + p.replace(/\n/g, '<br>') + '</p>')
    .join('');
}

function addMessage(role, text) {
  if (emptyEl) emptyEl.style.display = 'none';
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const isUser = role === 'user';
  wrap.innerHTML =
    '<div class="avatar">' + (isUser ? 'You' : 'D') + '</div>' +
    '<div><div class="role">' + (isUser ? 'You' : 'ProfessorDoom') + '</div>' +
    '<div class="bubble">' + (text ? render(text) : '') + '</div></div>';
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap.querySelector('.bubble');
}

function showTyping() {
  const bubble = addMessage('assistant', '');
  bubble.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  return bubble;
}

async function send() {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  busy = true;
  sendBtn.disabled = true;

  addMessage('user', text);
  history.push({ role: 'user', content: text });
  inputEl.value = '';
  autoGrow();

  const bubble = showTyping();

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });
    const data = await r.json();
    if (!r.ok) {
      bubble.innerHTML = render('**Error:** ' + (data.error || 'request failed.'));
    } else {
      bubble.innerHTML = render(data.reply || '(empty response)');
      history.push({ role: 'assistant', content: data.reply || '' });
    }
  } catch (e) {
    bubble.innerHTML = render('**Error:** could not reach the server.');
  } finally {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    busy = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

// ---- Composer behavior ----
function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
}
inputEl.addEventListener('input', autoGrow);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
sendBtn.addEventListener('click', send);

document.querySelectorAll('.suggestion').forEach((el) => {
  el.addEventListener('click', () => {
    inputEl.value = el.getAttribute('data-text');
    autoGrow();
    inputEl.focus();
  });
});

refreshStatus();
setInterval(refreshStatus, 15000);
