'use strict';

const $ = (id) => document.getElementById(id);
const bannerEl = $('banner');
const convListEl = $('convList');
const threadInner = document.querySelector('.thread-inner');
const threadEl = $('thread');
const emptyEl = $('empty');
const inputEl = $('input');
const sendBtn = $('send');
const modelBtn = $('modelBtn');
const modelMenu = $('modelMenu');
const modelLabel = $('modelLabel');
const convNameEl = $('convName');
const whoEl = $('who');

let GUMMIE_ID = '';
let CURRENT_INTERACTION = null;
// Restore the previously-chosen model so a refresh / skill change keeps it.
let SELECTED_MODEL = (function () {
  try {
    const saved = JSON.parse(localStorage.getItem('pd_model') || 'null');
    if (saved && saved.value) return saved;
  } catch {}
  return { label: 'Claude 4.8 Opus', value: 'gummies_smartest' };
})();
let SEND_CONFIGURED = false;
let busy = false;
let currentAbort = null;   // AbortController for the in-flight streaming turn
let REINJECT_NEXT = false; // re-apply the working contract on the next message
let SELECTED_SKILL = localStorage.getItem('pd_skill') || '';
// ---- Auto-continue: keep the agent working turn-after-turn without the user
// typing "continue". Persisted; capped for safety so it can never run away.
let AUTO_CONTINUE = localStorage.getItem('pd_autocontinue') === '1';
const AUTO_CAP = (function () { const n = parseInt(localStorage.getItem('pd_autocap') || '', 10); return Number.isFinite(n) && n > 0 ? n : 25; })();
let autoRounds = 0;            // consecutive auto-continues in the current run
let autoStopRequested = false; // set by Stop / toggle-off to break the loop
let autoLoopActive = false;    // a send()+auto-continue run is in progress

// ---------- helpers ----------
async function gl(pathAndQuery) {
  const r = await fetch('/api/gl/' + pathAndQuery.replace(/^\//, ''));
  const text = await r.text();
  if (!r.ok) throw new Error('Request ' + r.status + ': ' + text.slice(0, 200));
  try { return JSON.parse(text); } catch { return text; }
}

function render(text) {
  const esc = String(text || '').replace(/\u27e6TASK_COMPLETE\u27e7/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const withCode = esc.replace(/```([\s\S]*?)```/g, (_, c) => '<pre><code>' + c.trim() + '</code></pre>');
  const inline = withCode
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  return inline.split(/\n{2,}/).map((p) => (p.startsWith('<pre>') ? p : '<p>' + p.replace(/\n/g, '<br>') + '</p>')).join('');
}

// extract readable text from an assistant message's parts[]
function partsToText(msg) {
  if (typeof msg.content === 'string' && msg.content) return msg.content;
  const parts = msg.parts || [];
  const texts = parts.filter((p) => p.type === 'text' && p.text).map((p) => p.text);
  return texts.join('\n');
}

// ---------- status ----------
async function refreshStatus() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    GUMMIE_ID = s.gummieId || '';
    window.SITEKEYS = { turnstile: s.turnstileSiteKey, hcaptcha: s.hcaptchaSiteKey };
    if (!s.configured) {
      bannerEl.className = 'banner show warn';
      bannerEl.innerHTML = 'Session not configured. Add your Gumloop credentials in the <a href="/admin">admin dashboard</a> to start chatting.';
      return false;
    }
    if (!GUMMIE_ID) {
      bannerEl.className = 'banner show warn';
      bannerEl.innerHTML = 'No agent selected. Set an <strong>Agent ID</strong> in the <a href="/admin">admin dashboard</a>.';
      return false;
    }
    bannerEl.className = 'banner';
    return true;
  } catch {
    bannerEl.className = 'banner show';
    bannerEl.textContent = 'Server offline.';
    return false;
  }
}

// ---------- profile ----------
async function loadProfile() {
  try {
    const p = await gl('user_profile');
    const u = Array.isArray(p) ? p[0] : p;
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.user_email || 'Signed in';
    whoEl.innerHTML = (u.profile_picture ? '<img src="' + u.profile_picture + '" alt="">' : '') + '<span>' + name + '</span>';
  } catch { /* ignore */ }
}

// ---------- models ----------
async function loadModels() {
  let data;
  try { data = await gl('allowed_gummies_models'); }
  catch { try { data = await (await fetch('models.json')).json(); } catch { return; } }
  const groups = data.model_groups || [];
  modelMenu.innerHTML = '';
  groups.forEach((g) => {
    const lbl = document.createElement('div');
    lbl.className = 'model-group-label';
    lbl.textContent = g.groupLabel;
    modelMenu.appendChild(lbl);
    (g.options || []).forEach((o) => {
      const name = o.label || o.mapped_model_name;
      const value = o.value || o.mapped_model_value;
      const m = o.metadata || {};
      const opt = document.createElement('div');
      opt.className = 'model-opt';
      opt.innerHTML =
        '<div><div class="name">' + name + '</div>' +
        (o.description || m.description ? '<div class="desc">' + (o.description || m.description) + '</div>' : '') +
        (m.intelligence_rating ? '<div class="ratings">Intelligence ' + m.intelligence_rating + '/5 · Speed ' + (m.speed_rating || '?') + '/5 · ' + (m.provider || '') + '</div>' : '') +
        '</div>';
      if (value === SELECTED_MODEL.value) opt.classList.add('selected');
      opt.addEventListener('click', () => {
        SELECTED_MODEL = { label: name, value };
        try { localStorage.setItem('pd_model', JSON.stringify(SELECTED_MODEL)); } catch {}
        modelLabel.textContent = name;
        modelMenu.classList.remove('show');
        [...modelMenu.querySelectorAll('.model-opt')].forEach((e) => e.classList.remove('selected'));
        opt.classList.add('selected');
      });
      modelMenu.appendChild(opt);
    });
  });
  modelLabel.textContent = SELECTED_MODEL.label;
}
modelBtn.addEventListener('click', () => modelMenu.classList.toggle('show'));
document.addEventListener('click', (e) => { if (!e.target.closest('.model-select')) modelMenu.classList.remove('show'); });

// ---------- conversations ----------
let ALL_CONVS = [];

function relTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  const days = Math.floor(h / 24); if (days === 1) return 'yesterday';
  if (days < 7) return days + 'd ago';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function bucketOf(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || isNaN(d.getTime())) return 'Earlier';
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startToday) return 'Today';
  if (t >= startToday - 86400000) return 'Yesterday';
  if (t >= startToday - 6 * 86400000) return 'This week';
  return 'Earlier';
}
function renderConvSkeleton() {
  convListEl.innerHTML = Array.from({ length: 6 }).map(() =>
    '<div class="conv-skel"><div class="sk sk-1"></div><div class="sk sk-2"></div></div>').join('');
}

async function loadConversations() {
  if (!GUMMIE_ID) return;
  if (!ALL_CONVS.length) renderConvSkeleton();
  let data;
  try { data = await gl('gummies/' + GUMMIE_ID + '/chat?page_size=50&sort_order=newest'); }
  catch (e) { return; }
  ALL_CONVS = (data && data.data) || [];
  renderConvList();
}

// Render the (optionally filtered, date-grouped) conversation list. The search
// input is persistent in the DOM, so re-rendering the list never steals focus.
function renderConvList() {
  const fi = $('convFilter');
  const q = (fi ? fi.value : '').trim().toLowerCase();
  const items = ALL_CONVS.filter((c) => !q || (c.name || '').toLowerCase().includes(q));
  convListEl.innerHTML = '';
  if (!items.length) {
    convListEl.innerHTML = '<div class="conv-empty">' + (ALL_CONVS.length ? 'No matches' : 'No conversations yet') + '</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  let lastBucket = '';
  items.forEach((c) => {
    const b = bucketOf(c.created_ts);
    if (b !== lastBucket) {
      const lbl = document.createElement('div');
      lbl.className = 'conv-group-label';
      lbl.textContent = b;
      frag.appendChild(lbl);
      lastBucket = b;
    }
    const el = document.createElement('button');
    el.className = 'conv' + (c.interaction_id === CURRENT_INTERACTION ? ' active' : '');
    const st = (c.state || '').toLowerCase();
    el.innerHTML =
      '<div class="conv-row"><span class="conv-title">' + escH(c.name || 'Untitled') + '</span>' +
      '<span class="conv-time">' + escH(relTime(c.created_ts)) + '</span></div>' +
      (c.state ? '<div class="conv-meta"><span class="conv-state ' + escH(st) + '">' + escH(c.state) + '</span></div>' : '');
    el.addEventListener('click', () => {
      CURRENT_INTERACTION = c.interaction_id;
      renderConvList();
      openConversation(c.interaction_id, c.name, el);
    });
    frag.appendChild(el);
  });
  convListEl.appendChild(frag);
}

async function openConversation(interactionId, name, el) {
  CURRENT_INTERACTION = interactionId;
  convNameEl.textContent = name || 'Conversation';
  [...convListEl.querySelectorAll('.conv')].forEach((e) => e.classList.remove('active'));
  if (el) el.classList.add('active');
  threadInner.innerHTML = '<div class="empty"><span class="typing"><span></span><span></span><span></span></span></div>';
  try {
    const d = await gl('gummie_interactions/' + interactionId);
    const msgs = (d.interaction && d.interaction.messages) || [];
    renderThread(msgs);
  } catch (e) {
    threadInner.innerHTML = '<div class="empty"><p>Could not load this conversation.<br>' + e.message + '</p></div>';
  }
}

function renderThread(msgs) {
  threadInner.innerHTML = '';
  if (!msgs.length) {
    threadInner.innerHTML = '<div class="empty"><p>No messages in this conversation.</p></div>';
    return;
  }
  msgs.forEach((m) => {
    if (m.role === 'assistant') addRichMessage(renderAssistantParts(m.parts), (m.models && m.models[0]) || '');
    else addMessage(m.role, partsToText(m));
  });
  threadEl.scrollTop = threadEl.scrollHeight;
}

function addMessage(role, text, modelTag) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');
  const isUser = role === 'user';
  wrap.innerHTML =
    '<div class="avatar">' + (isUser ? 'You' : 'D') + '</div>' +
    '<div class="body"><div class="role">' + (isUser ? 'You' : 'ProfessorDoom') +
    (modelTag ? '<span class="model-tag">' + modelTag + '</span>' : '') + '</div>' +
    '<div class="bubble">' + (text ? render(text) : '') + '</div></div>';
  threadInner.appendChild(wrap);
  return wrap.querySelector('.bubble');
}

function escH(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Append an assistant message whose body is pre-built HTML (rich parts).
function addRichMessage(html, modelTag) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML =
    '<div class="avatar">D</div>' +
    '<div class="body"><div class="role">ProfessorDoom' +
    (modelTag ? '<span class="model-tag">' + escH(modelTag) + '</span>' : '') + '</div>' +
    '<div class="bubble">' + (html || '') + '</div></div>';
  threadInner.appendChild(wrap);
  return wrap.querySelector('.bubble');
}

// Build rich HTML from a Gumloop assistant message's parts[]:
// reasoning -> collapsible thinking, tool_invocation -> step chips,
// text -> answer, file -> download card, ask_human_input -> pending questions.
function renderAssistantParts(parts) {
  parts = parts || [];
  const steps = [];
  let answer = '', files = '', ask = '';
  for (const p of parts) {
    if (p.type === 'reasoning' && p.reasoning) {
      steps.push('<div class="step step-think"><span class="step-ico">💭</span><div class="step-txt">' + escH(p.reasoning) + '</div></div>');
    } else if (p.type === 'tool_invocation') {
      const cap = p.toolCaption || p.toolName || 'tool';
      const st = (p.toolCallState || '').toLowerCase();
      const badge = st ? '<span class="tool-state ' + escH(st) + '">' + escH(st) + '</span>' : '';
      const nm = p.toolName ? '<span class="tool-name">' + escH(p.toolName) + '</span>' : '';
      steps.push('<div class="step step-tool"><span class="step-ico">🔧</span><div class="step-txt"><span class="tool-cap">' + escH(cap) + '</span>' + nm + badge + '</div></div>');
      if (p.toolName === 'ask_human_input') {
        try {
          const qs = (p.result && p.result.args && p.result.args.questions) || [];
          if (qs.length) {
            ask = '<div class="ask-block"><div class="ask-head">The reviewer is waiting on your answers:</div><ol>' +
              qs.map((q) => '<li><strong>' + escH(q.title || q.name || '') + '</strong>' + (q.prompt ? '<br>' + escH(q.prompt) : '') + '</li>').join('') +
              '</ol><div class="ask-hint">Reply in the box below to continue.</div></div>';
          }
        } catch {}
      }
    } else if (p.type === 'text' && p.text) {
      answer += render(p.text);
    } else if (p.type === 'file' && p.file) {
      const f = p.file;
      const nm = String(f.filename || 'file').split('/').pop();
      const url = f.artifact_url || '';
      files += '<a class="file-card"' + (url ? ' href="' + escH(url) + '" target="_blank" rel="noopener"' : '') + '>' +
        '<span class="file-ico">📄</span><span class="file-meta"><span class="file-name">' + escH(nm) + '</span>' +
        '<span class="file-type">' + escH(f.media_type || '') + '</span></span><span class="file-dl">Download</span></a>';
    }
  }
  let html = '';
  if (steps.length) {
    html += '<details class="agent-steps"><summary><span class="steps-label">Thinking &amp; steps</span>' +
      '<span class="steps-count">' + steps.length + '</span></summary><div class="steps-body">' + steps.join('') + '</div></details>';
  }
  if (answer) html += '<div class="answer">' + answer + '</div>';
  if (files) html += '<div class="files">' + files + '</div>';
  if (ask) html += ask;
  return html || render('(no content)');
}

// ---------- captcha ----------
// hCaptcha is the real server-side check (renders on any domain).
// The Turnstile sitekey is domain-locked and won't render here; the server only
// checks that a turnstile token is PRESENT, so we send a placeholder.
const captcha = { turnstileId: null, hcaptchaId: null, hToken: '', pendingResolve: null };

// Verification runs INVISIBLY so a fresh, single-use hCaptcha token can be minted
// programmatically for every turn (manual or auto-continue) without the user
// re-clicking. hCaptcha only surfaces a visible challenge when it decides the
// session needs one; otherwise it passes silently and fires the callback.
function renderCaptcha() {
  const tk = window.SITEKEYS || {};
  const renderH = () => {
    if (window.hcaptcha && captcha.hcaptchaId === null && tk.hcaptcha) {
      try {
        captcha.hcaptchaId = window.hcaptcha.render('hcaptcha', {
          sitekey: tk.hcaptcha, size: 'invisible', theme: 'light',
          callback: (tok) => { captcha.hToken = tok || ''; setVerified(true); const r = captcha.pendingResolve; captcha.pendingResolve = null; if (r) r(captcha.hToken); },
          'expired-callback': () => { captcha.hToken = ''; setVerified(false); },
          'error-callback': () => { captcha.hToken = ''; setVerified(false); const r = captcha.pendingResolve; captcha.pendingResolve = null; if (r) r(''); },
          'chalexpired-callback': () => { captcha.hToken = ''; setVerified(false); const r = captcha.pendingResolve; captcha.pendingResolve = null; if (r) r(''); },
        });
      } catch { setTimeout(renderH, 400); }
    } else if (!window.hcaptcha) setTimeout(renderH, 400);
  };
  renderH();
  // Turnstile is domain-locked on self-hosted origins; best-effort only. The
  // server merely checks a token is PRESENT (a placeholder is accepted).
  const renderT = () => {
    const box = document.getElementById('turnstile');
    if (window.turnstile && captcha.turnstileId === null && tk.turnstile) {
      try { captcha.turnstileId = window.turnstile.render('#turnstile', { sitekey: tk.turnstile, theme: 'light', size: 'invisible', callback: () => {}, 'error-callback': () => { if (box) box.style.display = 'none'; } }); }
      catch { if (box) box.style.display = 'none'; }
    } else if (!window.turnstile) setTimeout(renderT, 400);
  };
  renderT();
}

function turnstileToken() {
  try { return (window.turnstile && captcha.turnstileId !== null) ? (window.turnstile.getResponse(captcha.turnstileId) || '') : ''; } catch { return ''; }
}

// Mint a FRESH verification token for one turn. Resolves with the hCaptcha token
// (empty string if it couldn't be obtained) plus a best-effort Turnstile token.
// Used identically for a manual send and for every auto-continue round.
function executeCaptcha() {
  return new Promise((resolve) => {
    try { if (window.turnstile && captcha.turnstileId !== null) window.turnstile.reset(captcha.turnstileId); } catch {}
    try { if (window.turnstile && captcha.turnstileId !== null) window.turnstile.execute(captcha.turnstileId); } catch {}
    if (!window.hcaptcha || captcha.hcaptchaId === null) { resolve({ hcaptcha_token: '', turnstile_token: turnstileToken() }); return; }
    let settled = false;
    const finish = (tok) => { if (settled) return; settled = true; captcha.pendingResolve = null; resolve({ hcaptcha_token: tok || '', turnstile_token: turnstileToken() }); };
    captcha.pendingResolve = finish;
    try { window.hcaptcha.reset(captcha.hcaptchaId); } catch {}
    try { window.hcaptcha.execute(captcha.hcaptchaId); } catch { finish(''); }
    setTimeout(() => finish(''), 90000); // challenge ignored/blocked -> give up gracefully
  });
}

// Collapse the verification bar to a slim "verified" state once a token exists.
function setVerified(ok) {
  const bar = document.getElementById('captchaBar');
  if (bar) bar.classList.toggle('solved', !!ok);
}

// Small status line for the auto-continue loop.
function showAutoNote(msg, sticky) {
  const el = document.getElementById('autoNote');
  if (!el) return;
  el.textContent = msg; el.style.display = '';
  el.classList.toggle('done', !!sticky);
}
function clearAutoNote() {
  const el = document.getElementById('autoNote');
  if (el) { el.textContent = ''; el.style.display = 'none'; el.classList.remove('done'); }
}

// ---------- send (LIVE streaming over SSE) ----------
// Build the live "Thinking & steps" + answer HTML from the in-flight stream
// state, with a status line that reflects what the agent is doing right now.
function renderLive(bubble, live) {
  let html = '';
  if (live.steps.length) {
    const stepHtml = live.steps.map((s) => s.kind === 'think'
      ? '<div class="step step-think"><span class="step-ico">💭</span><div class="step-txt">' + escH(s.text) + '</div></div>'
      : '<div class="step step-tool"><span class="step-ico">🔧</span><div class="step-txt"><span class="tool-cap">' + escH(s.cap) + '</span>' +
        (s.name ? '<span class="tool-name">' + escH(s.name) + '</span>' : '') +
        (s.state ? '<span class="tool-state ' + escH(s.state) + '">' + escH(s.state) + '</span>' : '') + '</div></div>'
    ).join('');
    html += '<details class="agent-steps" open><summary><span class="steps-label">Thinking &amp; steps</span>' +
      '<span class="steps-count">' + live.steps.length + '</span></summary><div class="steps-body">' + stepHtml + '</div></details>';
  }
  if (live.answer) html += '<div class="answer">' + render(live.answer) + '</div>';
  if (live.status) html += '<div class="live-status"><span class="live-dot"></span><span>' + escH(live.status) + '</span></div>';
  bubble.innerHTML = html || '<span class="typing"><span></span><span></span><span></span></span>';
}

// Interpret one Gumloop frame into the live state (defensive — frame shapes can
// vary; the authoritative re-render happens on `done`).
function applyFrame(f, live) {
  if (!f || typeof f !== 'object') return;
  const type = f.type || '';
  // Branch by type FIRST. Reasoning frames also carry a `text` field, so the
  // answer-text branch must come LAST to avoid leaking reasoning into the answer.
  if (type === 'reasoning' || (f.reasoning && type !== 'tool_invocation' && !f.toolName)) {
    const r = f.reasoning || f.text || '';
    if (r) {
      const last = live.steps[live.steps.length - 1];
      if (last && last.kind === 'think') last.text += r; else live.steps.push({ kind: 'think', text: r });
      live.status = 'Thinking…';
    }
    return;
  }
  if (type === 'tool_invocation' || f.toolName || f.toolCaption) {
    const cap = f.toolCaption || f.toolName || 'tool';
    const name = f.toolName || '';
    const st = (f.toolCallState || '').toLowerCase();
    const key = name + '|' + cap;
    const existing = live.steps.find((s) => s.kind === 'tool' && s.key === key);
    if (existing) { if (st) existing.state = st; }
    else live.steps.push({ kind: 'tool', cap, name, state: st, key });
    live.status = 'Running ' + (name || 'a tool') + '…';
    return;
  }
  if (type === 'step-start') { if (!live.answer) live.status = 'Working…'; return; }
  // Plain answer text / deltas (only reached when not a reasoning or tool frame).
  if (typeof f.text === 'string' && f.text) { live.answer += f.text; live.status = 'Writing the response…'; return; }
  if (typeof f.delta === 'string' && f.delta) { live.answer += f.delta; live.status = 'Writing the response…'; return; }
}

function parseSSE(chunk) {
  const lines = chunk.split('\n');
  let event = 'message', data = '';
  for (const ln of lines) {
    if (ln.startsWith(':')) continue;              // heartbeat / comment
    if (ln.startsWith('event:')) event = ln.slice(6).trim();
    else if (ln.startsWith('data:')) data += ln.slice(5).trim();
  }
  let obj = null; try { obj = data ? JSON.parse(data) : null; } catch {}
  return { event, obj };
}

// Toggle the composer button between Send (paper plane) and Stop (square).
function setSendingUI(on) {
  sendBtn.disabled = false;
  if (on) {
    sendBtn.classList.add('busy');
    sendBtn.title = 'Stop';
    sendBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';
  } else {
    sendBtn.classList.remove('busy');
    sendBtn.title = 'Send';
    sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  }
}

// Cancel the in-flight turn. Aborting the fetch closes the SSE connection, which
// makes the server tear down its upstream Gumloop WebSocket.
function stopTurn() { autoStopRequested = true; clearAutoNote(); if (currentAbort) { try { currentAbort.abort(); } catch {} } }

// If the stream drops unexpectedly (network), the turn may still finish on the
// server. Recover the completed turn from the REST interaction with a few polls.
async function recoverTurn(bubble, live) {
  if (!CURRENT_INTERACTION) return false;
  live.status = 'Reconnecting…'; renderLive(bubble, live);
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const d = await gl('gummie_interactions/' + CURRENT_INTERACTION);
      const msgs = (d.interaction && d.interaction.messages) || [];
      const last = [...msgs].reverse().find((m) => m.role === 'assistant');
      if (last && last.parts && last.parts.length) {
        bubble.innerHTML = renderAssistantParts(last.parts);
        loadConversations();
        return true;
      }
    } catch { /* keep polling */ }
  }
  return false;
}

// Run exactly ONE turn: mint a fresh captcha token, stream the agent's turn
// live, and return its outcome so the auto-continue loop can decide what's next.
async function runTurn(text, opts) {
  opts = opts || {};
  const outcome = { pending: false, complete: false, error: false, stopped: false, sent: false };

  const { hcaptcha_token, turnstile_token } = await executeCaptcha();
  if (!hcaptcha_token) {
    flash('Could not get a verification token \u2014 complete the human check to continue.');
    return outcome;
  }
  // Turnstile is domain-locked; the server only checks token presence.
  const turnstile = turnstile_token || 'na';
  outcome.sent = true;

  busy = true;
  const abort = new AbortController();
  currentAbort = abort;
  setSendingUI(true);
  if (emptyEl) emptyEl.remove();
  const ub = addMessage('user', text);
  if (opts.auto && ub) { const m = ub.closest('.msg'); if (m) m.classList.add('auto-msg'); }
  if (!opts.auto) { inputEl.value = ''; autoGrow(); }

  const bubble = addRichMessage('', SELECTED_MODEL.label);
  const live = { steps: [], answer: '', status: 'Connecting\u2026' };
  renderLive(bubble, live);
  threadEl.scrollTop = threadEl.scrollHeight;

  // On-demand contract re-injection (new conversation or skill changed mid-chat).
  const reinject = REINJECT_NEXT; REINJECT_NEXT = false; updateSkillNote();

  let finished = false;
  try {
    const resp = await fetch('/api/send/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: abort.signal,
      body: JSON.stringify({
        interaction_id: CURRENT_INTERACTION,
        message: text,
        turnstile_token: turnstile,
        hcaptcha_token,
        skill: SELECTED_SKILL || '',
        reinject,
        autocontinue: AUTO_CONTINUE,
      }),
    });
    if (!resp.ok || !resp.body) {
      const t = await resp.text(); let d = {}; try { d = JSON.parse(t); } catch {}
      bubble.innerHTML = render('**Send failed.** ' + (d.error || t));
      outcome.error = true; finished = true;
    } else {
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const atBottom = () => threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 120;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const { event, obj } = parseSSE(chunk);
          const stick = atBottom();
          if (event === 'start' && obj) {
            if (obj.interaction_id) CURRENT_INTERACTION = obj.interaction_id;
            live.status = 'Thinking\u2026'; renderLive(bubble, live);
          } else if (event === 'frame' && obj) {
            applyFrame(obj, live); renderLive(bubble, live);
          } else if (event === 'error' && obj) {
            outcome.error = true;
            live.status = ''; live.answer += (live.answer ? '\n\n' : '') + '**Error:** ' + (obj.error || 'unknown');
            renderLive(bubble, live);
          } else if (event === 'done' && obj) {
            finished = true;
            outcome.pending = !!obj.pending;
            outcome.complete = !!obj.complete;
            if (obj.parts && obj.parts.length) bubble.innerHTML = renderAssistantParts(obj.parts);
            else bubble.innerHTML = render(obj.reply || live.answer || '(no text returned)');
            loadConversations();
          }
          if (stick) threadEl.scrollTop = threadEl.scrollHeight;
        }
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      outcome.stopped = true; finished = true; live.status = '';
      if (live.steps.length || live.answer) {
        renderLive(bubble, live);
        bubble.insertAdjacentHTML('beforeend', '<div class="live-status stopped">\u23f9 Stopped</div>');
      } else {
        bubble.innerHTML = render('_Stopped before any output._');
      }
    } else if (!finished) {
      const recovered = await recoverTurn(bubble, live);
      if (!recovered) { outcome.error = true; live.status = ''; live.answer += (live.answer ? '\n\n' : '') + '**Connection lost.** ' + e.message; renderLive(bubble, live); }
      finished = true;
    }
  } finally {
    if (!finished && !live.answer && !live.steps.length) bubble.innerHTML = render('**No response received.** The connection closed before any output.');
    currentAbort = null;
    setSendingUI(false);
    threadEl.scrollTop = threadEl.scrollHeight;
    busy = false;
  }
  return outcome;
}

// Composer entry point. Sends the user's message, then \u2014 if Auto-continue is ON
// \u2014 keeps the agent working ("continue") turn after turn until it finishes
// (\u27e6TASK_COMPLETE\u27e7), asks the user something (ask_human_input), errors, is
// stopped, or hits the safety cap. No manual "continue" typing required.
async function send() {
  if (busy || autoLoopActive) return;
  const first = inputEl.value.trim();
  if (!first) return;

  autoRounds = 0; autoStopRequested = false; autoLoopActive = true;
  try {
    let outcome = await runTurn(first, { auto: false });
    if (!outcome.sent) return;

    while (AUTO_CONTINUE && !autoStopRequested
           && !outcome.stopped && !outcome.error && !outcome.pending && !outcome.complete) {
      if (autoRounds >= AUTO_CAP) {
        showAutoNote('Auto-continue paused after ' + AUTO_CAP + ' rounds \u2014 press Send to keep going.', true);
        return;
      }
      autoRounds++;
      showAutoNote('Auto-continuing\u2026 round ' + autoRounds + '/' + AUTO_CAP + ' \u00b7 press Stop to end');
      await new Promise((r) => setTimeout(r, 500));
      if (autoStopRequested) break;
      outcome = await runTurn('continue', { auto: true });
    }

    if (outcome.complete) showAutoNote('\u2713 Task complete.', true);
    else if (outcome.pending) showAutoNote('Paused \u2014 the agent needs your input. Reply below.', true);
    else clearAutoNote();
  } finally {
    autoLoopActive = false;
    setSendingUI(false);
    inputEl.focus();
  }
}

function flash(msg) {
  const h = document.querySelector('.hint');
  if (!h) return;
  const prev = h.textContent;
  h.textContent = msg; h.style.color = 'var(--accent-hover)';
  setTimeout(() => { h.textContent = prev; h.style.color = ''; }, 3000);
}

// ---------- composer ----------
function autoGrow() { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px'; }
inputEl.addEventListener('input', autoGrow);
inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
sendBtn.addEventListener('click', () => { if (busy || autoLoopActive) stopTurn(); else send(); });
$('newChat').addEventListener('click', () => {
  CURRENT_INTERACTION = null;
  convNameEl.textContent = 'New chat';
  renderConvList();
  threadInner.innerHTML = '<div class="empty"><div class="big">New conversation</div><p>Type below to start' + (SELECTED_SKILL ? ' under the <strong>' + (skillLabel(SELECTED_SKILL) || 'selected') + '</strong> contract' : '') + '. Sent using the selected model.</p></div>';
  inputEl.focus();
});

// ---------- skills ----------
const skillSelectEl = $('skillSelect');
const skillNoteEl = $('skillNote');
let SKILLS = [];
function skillLabel(slug) { const s = SKILLS.find((x) => x.slug === slug); return s ? s.label : ''; }
function updateSkillNote() {
  if (!skillNoteEl) return;
  const s = SKILLS.find((x) => x.slug === SELECTED_SKILL);
  if (!SELECTED_SKILL) { skillNoteEl.textContent = ''; return; }
  if (REINJECT_NEXT && s && s.hasContract) {
    skillNoteEl.textContent = '· contract will be applied on your next message';
    return;
  }
  skillNoteEl.textContent = (s && s.hasContract) ? '· contract active' : '· no contract uploaded yet';
}
async function loadSkills() {
  if (!skillSelectEl) return;
  try {
    const { skills } = await (await fetch('/api/skills')).json();
    SKILLS = skills || [];
    skillSelectEl.innerHTML = '<option value="">Normal chat (no skill)</option>' +
      SKILLS.map((s) => '<option value="' + s.slug + '"' + (s.slug === SELECTED_SKILL ? ' selected' : '') + '>' + s.label + '</option>').join('');
    updateSkillNote();
  } catch { /* ignore */ }
}
if (skillSelectEl) {
  skillSelectEl.addEventListener('change', () => {
    SELECTED_SKILL = skillSelectEl.value;
    localStorage.setItem('pd_skill', SELECTED_SKILL);
    // Re-apply the contract on the next message if a skill is chosen while a
    // conversation is already open (a NEW chat injects it automatically).
    REINJECT_NEXT = Boolean(SELECTED_SKILL && CURRENT_INTERACTION);
    updateSkillNote();
  });
}

// ---------- auto-continue toggle ----------
(function wireAutoContinue() {
  const t = $('autoToggle');
  if (!t) return;
  t.checked = AUTO_CONTINUE;
  t.addEventListener('change', () => {
    AUTO_CONTINUE = t.checked;
    localStorage.setItem('pd_autocontinue', AUTO_CONTINUE ? '1' : '0');
    if (!AUTO_CONTINUE) { autoStopRequested = true; clearAutoNote(); }
  });
})();

// ---------- boot ----------
// Live filtering of the conversation list (input is persistent, so focus is kept).
(function wireConvFilter() {
  const fi = $('convFilter');
  if (fi) fi.addEventListener('input', () => renderConvList());
})();

(async function init() {
  // Model picker is static metadata (API with models.json fallback) — always
  // populate it so the dropdown works regardless of session/verification state.
  await loadModels();
  // Skills come from /api/skills (the admin-configured list) and aren't tied to
  // the Gumloop session — load them too so the composer's skill picker is populated.
  await loadSkills();
  const ok = await refreshStatus();
  // Always render the verification widget so the "I am human" check is visible
  // regardless of session/agent config — the site keys are served independently.
  renderCaptcha();
  if (ok) {
    loadProfile();
    await loadConversations();
  }
  setInterval(refreshStatus, 20000);
})();
