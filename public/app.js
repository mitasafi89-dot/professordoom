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
let SELECTED_MODEL = { label: 'Claude 4.8 Opus', value: 'gummies_smartest' };
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
      bannerEl.className = 'banner';
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
      opt.addEventListener('click', () => {
        SELECTED_MODEL = { label: name, value };
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
async function loadConversations() {
  if (!GUMMIE_ID) return;
  let data;
  try { data = await gl('gummies/' + GUMMIE_ID + '/chat?page_size=24&sort_order=newest'); }
  catch (e) { return; }
  const items = (data && data.data) || [];
  convListEl.innerHTML = '<div class="conv-section">Conversations</div>';
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'conv-section';
    d.style.color = 'var(--text-faint)';
    d.textContent = 'No conversations yet';
    convListEl.appendChild(d);
    return;
  }
  items.forEach((c) => {
    const el = document.createElement('button');
    el.className = 'conv';
    const when = c.created_ts ? new Date(c.created_ts).toLocaleDateString() : '';
    el.innerHTML =
      '<div class="title">' + (c.name || 'Untitled') + '</div>' +
      '<div class="meta"><span class="state">' + (c.state || '') + '</span><span>' + when + '</span></div>';
    el.addEventListener('click', () => openConversation(c.interaction_id, c.name, el));
    convListEl.appendChild(el);
  });
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
  msgs.forEach((m) => addMessage(m.role, partsToText(m), (m.models && m.models[0]) || ''));
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
      try { captcha.hcaptchaId = window.hcaptcha.render('hcaptcha', { sitekey: tk.hcaptcha, theme: 'dark', size: 'normal' }); }
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
          sitekey: tk.turnstile, theme: 'dark',
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
}

// ---------- send ----------
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
  const bubble = addMessage('assistant', '');
  bubble.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  threadEl.scrollTop = threadEl.scrollHeight;

  try {
    const r = await fetch('/api/send', {
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
    const txt = await r.text();
    let data; try { data = JSON.parse(txt); } catch { data = {}; }
    if (!r.ok) {
      bubble.innerHTML = render('**Send failed.** ' + (data.error || txt));
    } else {
      if (data.interaction_id) CURRENT_INTERACTION = data.interaction_id;
      bubble.innerHTML = render(data.reply || '(no text returned)');
      loadConversations();
    }
  } catch (e) {
    bubble.innerHTML = render('**Error:** ' + e.message);
  } finally {
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
  [...convListEl.querySelectorAll('.conv')].forEach((e) => e.classList.remove('active'));
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
(async function init() {
  // Model picker is static metadata (API with models.json fallback) — always
  // populate it so the dropdown works regardless of session/verification state.
  await loadModels();
  // Skills come from /api/skills (the admin-configured list) and aren't tied to
  // the Gumloop session — load them too so the composer's skill picker is populated.
  await loadSkills();
  const ok = await refreshStatus();
  if (ok) {
    renderCaptcha();
    loadProfile();
    await loadConversations();
  }
  setInterval(refreshStatus, 20000);
})();
