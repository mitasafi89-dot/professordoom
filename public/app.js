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
let SELECTED_SKILL = localStorage.getItem('pd_skill') || '';

// ---------- helpers ----------
async function gl(pathAndQuery) {
  const r = await fetch('/api/gl/' + pathAndQuery.replace(/^\//, ''));
  const text = await r.text();
  if (!r.ok) throw new Error('Request ' + r.status + ': ' + text.slice(0, 200));
  try { return JSON.parse(text); } catch { return text; }
}

function render(text) {
  const esc = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
const captcha = { turnstileId: null, hcaptchaId: null, turnstileOk: false };

function renderCaptcha() {
  const tk = window.SITEKEYS || {};
  // hCaptcha — required
  const renderH = () => {
    if (window.hcaptcha && captcha.hcaptchaId === null && tk.hcaptcha) {
      try { captcha.hcaptchaId = window.hcaptcha.render('hcaptcha', { sitekey: tk.hcaptcha, theme: 'light', size: 'normal',
        callback: () => setVerified(true),
        'expired-callback': () => setVerified(false),
        'error-callback': () => setVerified(false),
        'chalexpired-callback': () => setVerified(false) }); }
      catch { setTimeout(renderH, 400); }
    } else if (!window.hcaptcha) setTimeout(renderH, 400);
  };
  renderH();
  // Turnstile — best effort; hide gracefully if its sitekey rejects this domain
  const renderT = () => {
    const box = document.getElementById('turnstile');
    if (window.turnstile && captcha.turnstileId === null && tk.turnstile) {
      try {
        captcha.turnstileId = window.turnstile.render('#turnstile', {
          sitekey: tk.turnstile, theme: 'light',
          callback: () => { captcha.turnstileOk = true; },
          'error-callback': () => { if (box) box.style.display = 'none'; },
        });
      } catch { if (box) box.style.display = 'none'; }
    } else if (!window.turnstile) setTimeout(renderT, 400);
  };
  renderT();
}

function getCaptchaTokens() {
  let t = '', h = '';
  try { if (window.turnstile && captcha.turnstileId !== null) t = window.turnstile.getResponse(captcha.turnstileId) || ''; } catch {}
  try { if (window.hcaptcha && captcha.hcaptchaId !== null) h = window.hcaptcha.getResponse(captcha.hcaptchaId) || ''; } catch {}
  return { turnstile_token: t, hcaptcha_token: h };
}

function resetCaptcha() {
  try { if (window.turnstile && captcha.turnstileId !== null) window.turnstile.reset(captcha.turnstileId); } catch {}
  try { if (window.hcaptcha && captcha.hcaptchaId !== null) window.hcaptcha.reset(captcha.hcaptchaId); } catch {}
  setVerified(false);
}

// Collapse the verification bar to a slim "✓ verified" chip once solved.
function setVerified(ok) {
  const bar = document.getElementById('captchaBar');
  if (bar) bar.classList.toggle('solved', !!ok);
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

async function send() {
  const text = inputEl.value.trim();
  if (!text || busy) return;

  const { turnstile_token, hcaptcha_token } = getCaptchaTokens();
  if (!hcaptcha_token) {
    flash('Complete the "I am human" check above before sending.');
    return;
  }
  // Turnstile is domain-locked; the server only checks token presence.
  const turnstile = turnstile_token || 'na';

  busy = true; sendBtn.disabled = true;
  if (emptyEl) emptyEl.remove();
  addMessage('user', text);
  inputEl.value = ''; autoGrow();

  const bubble = addRichMessage('', SELECTED_MODEL.label);
  const live = { steps: [], answer: '', status: 'Connecting…' };
  renderLive(bubble, live);
  threadEl.scrollTop = threadEl.scrollHeight;

  let finished = false;
  try {
    const resp = await fetch('/api/send/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        interaction_id: CURRENT_INTERACTION,
        message: text,
        turnstile_token: turnstile,
        hcaptcha_token,
        skill: SELECTED_SKILL || '',
      }),
    });
    if (!resp.ok || !resp.body) {
      const t = await resp.text(); let d = {}; try { d = JSON.parse(t); } catch {}
      bubble.innerHTML = render('**Send failed.** ' + (d.error || t));
      finished = true;
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
            live.status = 'Thinking…'; renderLive(bubble, live);
          } else if (event === 'frame' && obj) {
            applyFrame(obj, live); renderLive(bubble, live);
          } else if (event === 'error' && obj) {
            live.status = ''; live.answer += (live.answer ? '\n\n' : '') + '**Error:** ' + (obj.error || 'unknown');
            renderLive(bubble, live);
          } else if (event === 'done' && obj) {
            finished = true;
            if (obj.parts && obj.parts.length) bubble.innerHTML = renderAssistantParts(obj.parts);
            else bubble.innerHTML = render(obj.reply || live.answer || '(no text returned)');
            if (obj.is_new) { convNameEl.textContent = convNameEl.textContent || 'Conversation'; }
            loadConversations();
          }
          if (stick) threadEl.scrollTop = threadEl.scrollHeight;
        }
      }
    }
  } catch (e) {
    if (!finished) { live.status = ''; live.answer += (live.answer ? '\n\n' : '') + '**Error:** ' + e.message; renderLive(bubble, live); }
  } finally {
    if (!finished && !live.answer && !live.steps.length) bubble.innerHTML = render('**No response received.** The connection closed before any output.');
    resetCaptcha(); // tokens are single-use — force a fresh solve per message
    threadEl.scrollTop = threadEl.scrollHeight;
    busy = false; sendBtn.disabled = false; inputEl.focus();
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
sendBtn.addEventListener('click', send);
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
  skillNoteEl.textContent = !SELECTED_SKILL ? '' : (s && s.hasContract ? '· contract active' : '· no contract uploaded yet');
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
    updateSkillNote();
  });
}

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
