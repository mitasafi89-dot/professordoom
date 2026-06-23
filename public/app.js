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
const creditMeterEl = $('creditMeter');
const creditBarFillEl = $('creditBarFill');
const creditTextEl = $('creditText');
const errorBtnEl = $('errorBtn');
const errorCountEl = $('errorCount');
const errorPanelEl = $('errorPanel');
const errorListEl = $('errorList');
const docsBtnEl = $('docsBtn');
const docsCountEl = $('docsCount');
const docsPanelEl = $('docsPanel');
const docsListEl = $('docsList');

let GUMMIE_ID = '';
let CURRENT_INTERACTION = null;
// Map of stored-document artifact URL (origin+path, query-stripped) -> document id,
// so links to a Gumloop artifact can be served from our durable copy instead of
// sending the user to an external gumloop.com URL they may not be able to open.
let DOC_BY_URL = {};
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
let DB_CONNECTED = true; // whether the server is connected to Supabase (drives an honest skill note)
// ---- Auto-continue: keep the agent working turn-after-turn without the user
// typing "continue". Persisted; capped for safety so it can never run away.
// DEFAULT ON: long, multi-phase contract work (the common case here) should
// drive itself. A user who explicitly turns it off ('0') is respected; only an
// unset preference defaults to on.
let AUTO_CONTINUE = (localStorage.getItem('pd_autocontinue') || '1') !== '0';
const AUTO_CAP = (function () { const n = parseInt(localStorage.getItem('pd_autocap') || '', 10); return Number.isFinite(n) && n > 0 ? n : 25; })();
// If several auto-continue turns in a row produce NO new output (the agent is
// re-announcing the same next step without doing it, exactly the failure seen
// in long manuscript runs), stop the loop instead of burning turns/credits.
const STALL_CAP = (function () { const n = parseInt(localStorage.getItem('pd_stallcap') || '', 10); return Number.isFinite(n) && n > 0 ? n : 3; })();
let autoRounds = 0;            // consecutive auto-continues in the current run
let emptyStreak = 0;           // consecutive turns that produced no new output
let prevReplyNorm = '';        // normalized reply of the previous turn (repeat detection)
let autoStopRequested = false; // set by Stop / toggle-off to break the loop
let autoLoopActive = false;    // a send()+auto-continue run is in progress

// ---------- helpers ----------
async function gl(pathAndQuery) {
  const r = await fetch('/api/gl/' + pathAndQuery.replace(/^\//, ''));
  const text = await r.text();
  if (!r.ok) throw new Error('Request ' + r.status + ': ' + text.slice(0, 200));
  try { return JSON.parse(text); } catch { return text; }
}

function docUrlKey(u) { try { const x = new URL(u, location.origin); return x.origin + x.pathname; } catch { return String(u || ''); } }
function isArtifactHost(host) {
  host = (host || '').toLowerCase();
  return host === 'gumloop.com' || host.endsWith('.gumloop.com')
      || host === 'storage.googleapis.com' || host.endsWith('.storage.googleapis.com');
}
// Route a Gumloop artifact URL through THIS origin so the user can actually open
// it without a gumloop.com login: prefer the durable stored copy
// (/api/documents/:id) when we have captured it, else the hardened /api/file
// proxy. Same-origin and non-artifact external links are returned unchanged.
function artifactHref(url, text) {
  let u; try { u = new URL(url, location.origin); } catch { return url; }
  if (u.origin === location.origin) return url;
  if (!isArtifactHost(u.hostname)) return url;
  const id = DOC_BY_URL[docUrlKey(url)];
  if (id) return '/api/documents/' + encodeURIComponent(id);
  return '/api/file?url=' + encodeURIComponent(url) + '&name=' + encodeURIComponent((text || 'document').slice(0, 120));
}

function render(text) {
  let s = String(text || '').replace(/\u27e6TASK_COMPLETE\u27e7/g, '');
  // Pull links OUT before HTML-escaping so URLs + query strings survive intact,
  // route artifact links through this origin, then reinsert them as anchors.
  const links = [];
  const stash = (label, url) => '\u0000L' + (links.push({ label, url }) - 1) + '\u0000';
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => stash(t, u));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s)<>]+)/g, (m, pre, u) => {
    const trail = (u.match(/[.,;:!?]+$/) || [''])[0];
    if (trail) u = u.slice(0, -trail.length);
    return pre + stash(u, u) + trail;
  });
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const withCode = esc.replace(/```([\s\S]*?)```/g, (_, c) => '<pre><code>' + c.trim() + '</code></pre>');
  const inline = withCode
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  let html = inline.split(/\n{2,}/).map((p) => (p.startsWith('<pre>') ? p : '<p>' + p.replace(/\n/g, '<br>') + '</p>')).join('');
  return html.replace(/\u0000L(\d+)\u0000/g, (_, i) => {
    const lk = links[+i] || { label: '', url: '#' };
    return '<a href="' + escH(artifactHref(lk.url, lk.label)) + '" target="_blank" rel="noopener noreferrer">' + escH(lk.label) + '</a>';
  });
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

// ---------- credits ----------
let CREDITS_EXHAUSTED = false;
function fmtNum(n) {
  if (n == null) return '\u2014';
  return n >= 1000 ? Math.round(n).toLocaleString() : String(Math.round(n * 10) / 10);
}
async function refreshCredits() {
  if (!creditMeterEl) return;
  try {
    const r = await fetch('/api/credits');
    if (!r.ok) {
      // The server already recorded the failure; reflect "unavailable" and pull
      // the error into the log so it isn't silent.
      creditMeterEl.hidden = false; creditMeterEl.className = 'credit-meter err';
      if (creditTextEl) creditTextEl.textContent = 'Credits unavailable';
      if (creditBarFillEl) creditBarFillEl.style.width = '100%';
      refreshErrors();
      return;
    }
    const c = await r.json();
    creditMeterEl.hidden = false;
    const limit = c.limit, remaining = c.remaining;
    // Depleting bar: fraction of the limit still REMAINING (full = healthy,
    // empty = none). remaining can exceed the limit (overage/rollover) so cap at 100%.
    let pctLeft = null;
    if (limit && limit > 0 && remaining != null) pctLeft = Math.max(0, Math.min(100, (remaining / limit) * 100));
    // Treat a restriction / past-due / zero balance as "cannot run".
    CREDITS_EXHAUSTED = !!(c.blocked || c.exhausted);

    let cls = 'credit-meter';
    if (c.blocked || c.exhausted) cls += ' out';
    else if (pctLeft != null && pctLeft <= 10) cls += ' low';
    creditMeterEl.className = cls;
    if (creditBarFillEl) creditBarFillEl.style.width = (pctLeft == null ? 100 : pctLeft) + '%';

    if (creditTextEl) {
      if (c.exhausted) creditTextEl.textContent = 'Credits exhausted';
      else if (c.restricted) creditTextEl.textContent = 'Credits restricted';
      else if (c.pastDue) creditTextEl.textContent = 'Account past due';
      else if (remaining != null && limit != null) creditTextEl.textContent = fmtNum(remaining) + ' / ' + fmtNum(limit) + ' left';
      else if (remaining != null) creditTextEl.textContent = fmtNum(remaining) + ' left';
      else creditTextEl.textContent = 'Credits';
    }
    creditMeterEl.title = 'Gumloop credits' + (c.tier ? ' \u00b7 ' + c.tier : '') +
      (remaining != null ? ' \u00b7 ' + fmtNum(remaining) + ' remaining' : '') +
      (limit != null ? ' of ' + fmtNum(limit) : '') +
      (c.restrictionReason ? ' \u00b7 ' + c.restrictionReason : '');

    if (c.blocked || c.exhausted) {
      const why = c.restrictionReason ? (' ' + c.restrictionReason)
        : c.pastDue ? ' Your account is past due.'
        : c.restricted ? ' Your credits are restricted.'
        : ' The agent can\u2019t run until your plan is topped up.';
      bannerEl.className = 'banner show warn';
      bannerEl.innerHTML = '<strong>Out of Gumloop credits.</strong>' + escH(why);
    }
  } catch { /* server-offline is surfaced by refreshStatus */ }
}

// ---------- error log ----------
let ERRORS_OPEN = false;
function relTimeShort(ts) {
  const t = new Date(ts).getTime(); if (!isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}
async function refreshErrors() {
  if (!errorBtnEl) return;
  try {
    const d = await (await fetch('/api/errors')).json();
    const errs = d.errors || [];
    if (errorCountEl) {
      if (errs.length) { errorCountEl.hidden = false; errorCountEl.textContent = String(errs.length); errorBtnEl.classList.add('has-errors'); }
      else { errorCountEl.hidden = true; errorBtnEl.classList.remove('has-errors'); }
    }
    if (ERRORS_OPEN) renderErrorList(errs);
  } catch { /* ignore */ }
}
function renderErrorList(errs) {
  if (!errorListEl) return;
  if (!errs || !errs.length) {
    errorListEl.innerHTML = '<div class="error-empty">No errors. Gumloop is responding normally.</div>';
    return;
  }
  errorListEl.innerHTML = errs.map((e) =>
    '<div class="error-item' + (e.credit ? ' credit' : '') + '">' +
      '<div class="ei-top"><span class="ei-src">' + escH(e.source || 'error') + (e.code ? ' ' + escH(String(e.code)) : '') + '</span>' +
      '<span class="ei-time">' + escH(relTimeShort(e.ts)) + '</span></div>' +
      '<div class="ei-msg">' + escH(e.message || '') + '</div></div>').join('');
}
if (errorBtnEl) {
  errorBtnEl.addEventListener('click', async () => {
    ERRORS_OPEN = !ERRORS_OPEN;
    if (errorPanelEl) errorPanelEl.hidden = !ERRORS_OPEN;
    if (ERRORS_OPEN) { try { const d = await (await fetch('/api/errors')).json(); renderErrorList(d.errors || []); } catch { renderErrorList([]); } }
  });
  document.addEventListener('click', (e) => {
    if (ERRORS_OPEN && !e.target.closest('.error-wrap')) { ERRORS_OPEN = false; if (errorPanelEl) errorPanelEl.hidden = true; }
  });
}
const errorClearEl = $('errorClear');
if (errorClearEl) {
  errorClearEl.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await fetch('/api/errors/clear', { method: 'POST' }); } catch {}
    renderErrorList([]); refreshErrors();
  });
}

// ---------- documents (saved deliverables) ----------
let DOCS_OPEN = false;
let DOCS_SCOPE = 'chat'; // 'chat' = current conversation, 'all' = whole library
function bytesH(n) {
  if (!n || n <= 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
async function refreshDocuments() {
  if (!docsBtnEl) return;
  try {
    const iid = (DOCS_SCOPE === 'chat' && CURRENT_INTERACTION) ? CURRENT_INTERACTION : '';
    // In "chat" scope with no open conversation there are no docs to show.
    const q = (DOCS_SCOPE === 'chat') ? (iid ? '?interaction_id=' + encodeURIComponent(iid) : '?interaction_id=__none__') : '';
    const d = await (await fetch('/api/documents' + q)).json();
    const docs = d.documents || [];
    // Index artifact URL -> stored doc id so render() can link deliverables to
    // our durable copy instead of an external gumloop.com URL.
    DOC_BY_URL = {};
    for (const dn of docs) { if (dn.artifact_url) DOC_BY_URL[docUrlKey(dn.artifact_url)] = dn.id; }
    if (docsCountEl) {
      if (docs.length) { docsCountEl.hidden = false; docsCountEl.textContent = String(docs.length); docsBtnEl.classList.add('has-docs'); }
      else { docsCountEl.hidden = true; docsBtnEl.classList.remove('has-docs'); }
    }
    if (DOCS_OPEN) renderDocsList(docs);
  } catch { /* ignore */ }
}
function renderDocsList(docs) {
  if (!docsListEl) return;
  if (!docs || !docs.length) {
    docsListEl.innerHTML = '<div class="docs-empty">No saved documents yet. Deliverables are saved here automatically as the agent produces them.</div>';
    return;
  }
  docsListEl.innerHTML = docs.map((dn) => {
    const name = String(dn.filename || 'document');
    const mt = dn.media_type || '';
    const kind = previewKind(name, mt);
    const base = '/api/documents/' + encodeURIComponent(dn.id);
    const viewUrl = base, htmlUrl = base + '?as=html', dlUrl = base + '?dl=1';
    const preBtn = previewBtnHTML(name, mt, kind, viewUrl, htmlUrl, dlUrl);
    const meta = [
      (fileExt(name) ? fileExt(name).toUpperCase() : 'FILE'),
      bytesH(dn.bytes),
      (dn.version && dn.version > 1 ? 'v' + dn.version : ''),
      relTimeShort(dn.updated_at),
    ].filter(Boolean).join(' \u00b7 ');
    return '<div class="doc-item">' +
      '<span class="doc-ico">' + fileIcon(kind) + '</span>' +
      '<span class="doc-meta"><span class="doc-name">' + escH(name) + '</span>' +
      '<span class="doc-sub">' + escH(meta) + '</span></span>' +
      '<span class="doc-actions">' + preBtn +
      '<a class="file-btn file-dl" href="' + escH(dlUrl) + '">Download</a></span></div>';
  }).join('');
}
async function openDocs(show) {
  DOCS_OPEN = show;
  if (docsPanelEl) docsPanelEl.hidden = !show;
  if (show) {
    docsListEl.innerHTML = '<div class="docs-empty">Loading\u2026</div>';
    await refreshDocuments();
  }
}
if (docsBtnEl) {
  docsBtnEl.addEventListener('click', () => openDocs(!DOCS_OPEN));
  document.addEventListener('click', (e) => {
    if (DOCS_OPEN && !e.target.closest('.docs-wrap') && !e.target.closest('.preview-panel')) openDocs(false);
  });
}
['docsScopeChat', 'docsScopeAll'].forEach((id) => {
  const b = $(id); if (!b) return;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    DOCS_SCOPE = id === 'docsScopeAll' ? 'all' : 'chat';
    const c = $('docsScopeChat'), a = $('docsScopeAll');
    if (c) c.classList.toggle('active', DOCS_SCOPE === 'chat');
    if (a) a.classList.toggle('active', DOCS_SCOPE === 'all');
    refreshDocuments();
  });
});

// ---------- theme (dark default, light opt-out; persisted) ----------
(function wireTheme() {
  const btn = $('themeToggle');
  if (!btn) return;
  const sync = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    btn.setAttribute('aria-pressed', String(dark));
    btn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  };
  sync();
  btn.addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const next = dark ? 'light' : 'dark';
    if (next === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('pd_theme', next); } catch {}
    sync();
  });
})();

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
    el.innerHTML =
      '<div class="conv-row"><span class="conv-title">' + escH(c.name || 'Untitled') + '</span>' +
      '<span class="conv-time">' + escH(relTime(c.created_ts)) + '</span></div>';
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
  threadEl.classList.remove('is-landing');
  threadInner.innerHTML = '<div class="empty"><span class="typing"><span></span><span></span><span></span></span></div>';
  if (typeof refreshDocuments === 'function') refreshDocuments();
  try {
    const d = await gl('gummie_interactions/' + interactionId);
    const msgs = (d.interaction && d.interaction.messages) || [];
    renderThread(msgs);
  } catch (e) {
    threadInner.innerHTML = '<div class="empty"><p>Could not load this conversation.<br>' + e.message + '</p></div>';
  }
}

function landingHTML(subtitle) {
  const sub = subtitle || 'ProfessorDoom reads your work like a tough peer reviewer and goes straight for the weakest spot. Paste your work below to begin.';
  return ''
    + '<div class="landing">'
    +   '<div class="crest landing-crest" aria-hidden="true"></div>'
    +   '<h2 class="landing-title">Where should we begin?</h2>'
    +   '<p class="landing-sub">' + sub + '</p>'
    + '</div>';
}

function renderThread(msgs) {
  threadEl.classList.remove('is-landing');
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
  const toolSteps = [];
  let thinking = '', answer = '', files = '', ask = '';
  for (const p of parts) {
    if (p.type === 'reasoning' && p.reasoning) {
      thinking += (thinking ? '\n\n' : '') + p.reasoning;
    } else if (p.type === 'tool_invocation') {
      const cap = p.toolCaption || p.toolName || 'tool';
      // This is the AUTHORITATIVE render of a finished turn. A chip left at
      // "pending"/"running"/"" here is misleading (the tool already ran, Gumloop
      // just didn't echo a terminal state), so normalize it to a neutral "done".
      let st = (p.toolCallState || '').toLowerCase();
      if (!st || st === 'pending' || st === 'running' || st === 'in_progress' || st === 'in-progress' || st === 'started') st = 'done';
      toolSteps.push(toolStepHTML(cap, p.toolName || '', st));
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
      files += fileCardHTML(nm, f.artifact_url || '', f.media_type || '');
    }
  }
  let html = '';
  if (thinking) html += thinkingBlockHTML(thinking, false, false);
  if (toolSteps.length) html += stepsBlockHTML(toolSteps, false);
  if (answer) html += '<div class="answer">' + answer + '</div>';
  if (files) html += '<div class="files">' + files + '</div>';
  if (ask) html += ask;
  // A turn with no thinking, no tool, no answer and no file is a wasted turn.
  // Don't render a dead "(no content)" bubble: show an honest, muted note (and,
  // under auto-continue, make clear the loop is carrying on / will stop if this
  // keeps happening).
  if (!html) {
    return '<div class="empty-turn">No visible output this turn.' +
      (AUTO_CONTINUE ? ' Continuing automatically\u2026' : '') + '</div>';
  }
  return html;
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
  const thinking = live.steps.filter((s) => s.kind === 'think').map((s) => s.text).join('\n\n');
  const toolSteps = live.steps.filter((s) => s.kind === 'tool').map((s) => toolStepHTML(s.cap, s.name, s.state));
  // While no answer text has arrived yet the model is still reasoning, so keep
  // the thinking block open and pulsing (Claude-style live thought stream).
  const stillThinking = !live.answer;
  if (thinking) html += thinkingBlockHTML(thinking, stillThinking, stillThinking);
  if (toolSteps.length) html += stepsBlockHTML(toolSteps, true);
  if (live.answer) html += '<div class="answer">' + render(live.answer) + '</div>';
  if (live.status) html += '<div class="live-status"><span class="live-dot"></span><span>' + escH(live.status) + '</span></div>';
  bubble.innerHTML = html || '<span class="typing"><span></span><span></span><span></span></span>';
}

// Interpret one Gumloop frame into the live state (defensive, frame shapes can
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
  const outcome = { pending: false, complete: false, error: false, stopped: false, sent: false, empty: false };

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
  threadEl.classList.remove('is-landing');
  const emptyNow = threadInner.querySelector('.empty');
  if (emptyNow) emptyNow.remove();
  if (emptyEl) emptyEl.remove();
  const ub = addMessage('user', text + (!opts.auto && ATTACHMENTS.length ? '\n\n\u{1F4CE} ' + ATTACHMENTS.map((a) => a.filename).join(', ') : ''));
  if (!opts.auto && ATTACHMENTS.length) { ATTACHMENTS = []; renderAttachments(); }
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
        attachments: opts.auto ? [] : ATTACHMENTS.map((a) => ({ filename: a.filename, contentBase64: a.contentBase64 })),
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
            // Did this turn make real progress (any answer text, tool call, or
            // file)? Reasoning-only / blank turns count as "empty" so the
            // auto-continue loop can break a re-announcement stall.
            const rep = (obj.reply || '').trim();
            outcome.reply = rep;
            const repReal = rep && rep !== '(no text returned)' && rep !== '(no content)';
            const partsReal = Array.isArray(obj.parts) && obj.parts.some(
              (p) => (p.type === 'text' && p.text) || p.type === 'tool_invocation' || p.type === 'file');
            outcome.empty = !repReal && !partsReal;
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
    // After every turn, refresh credit usage and pull any new Gumloop errors so
    // consumption and failures are always current without a manual reload.
    refreshCredits();
    refreshErrors();
    refreshDocuments();
  }
  return outcome;
}

// Composer entry point. Sends the user's message, then \u2014 if Auto-continue is ON
// \u2014 keeps the agent working ("continue") turn after turn until it finishes
// (\u27e6TASK_COMPLETE\u27e7), asks the user something (ask_human_input), errors, is
// stopped, or hits the safety cap. No manual "continue" typing required.
async function send() {
  if (busy || autoLoopActive) return;
  if (CREDITS_EXHAUSTED) { flash('Out of Gumloop credits \u2014 top up your plan to continue.'); refreshCredits(); return; }
  const first = inputEl.value.trim();
  if (!first && !ATTACHMENTS.length) return;
  const firstMsg = first || 'Please review the attached file(s).';

  autoRounds = 0; emptyStreak = 0; prevReplyNorm = ''; autoStopRequested = false; autoLoopActive = true;
  try {
    let outcome = await runTurn(firstMsg, { auto: false });
    if (!outcome.sent) return;

    while (AUTO_CONTINUE && !autoStopRequested && !CREDITS_EXHAUSTED
           && !outcome.stopped && !outcome.error && !outcome.pending && !outcome.complete) {
      if (autoRounds >= AUTO_CAP) {
        showAutoNote('Auto-continue paused after ' + AUTO_CAP + ' rounds \u2014 press Send to keep going.', true);
        return;
      }
      // Stall guard: if the agent keeps ending turns without producing anything
      // new (the "re-announcing the same step" failure), stop instead of
      // burning the rest of the cap on empty turns.
      // A turn that produced nothing new -- OR a near-verbatim repeat of the
      // previous turn's reply (the agent re-declaring it is "done" without ever
      // emitting the completion token) -- counts toward the stall guard, so the
      // loop stops instead of spamming "continue" at a finished agent.
      const replyNorm = (outcome.reply || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const dupReply = replyNorm.length > 16 && replyNorm === prevReplyNorm;
      prevReplyNorm = replyNorm;
      emptyStreak = (outcome.empty || dupReply) ? emptyStreak + 1 : 0;
      if (emptyStreak >= STALL_CAP) {
        showAutoNote('Auto-continue stopped: ' + STALL_CAP + ' turns with no new output. Nudge the agent with a specific instruction.', true);
        return;
      }
      autoRounds++;
      showAutoNote('Auto-continuing\u2026 round ' + autoRounds + '/' + AUTO_CAP + ' \u00b7 press Stop to end');
      await new Promise((r) => setTimeout(r, 500));
      if (autoStopRequested) break;
      outcome = await runTurn('continue', { auto: true });
    }

    if (outcome.complete) showAutoNote('\u2713 Task complete.', true);
    else if (CREDITS_EXHAUSTED) showAutoNote('Stopped \u2014 out of Gumloop credits. Top up to continue.', true);
    else if (outcome.pending) showAutoNote('Paused \u2014 the agent needs your input. Reply below.', true);
    else if (outcome.empty && emptyStreak + (outcome.empty ? 1 : 0) >= STALL_CAP) { /* stall note already shown */ }
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
  threadEl.classList.add('is-landing');
  threadInner.innerHTML = '<div class="empty">' + landingHTML(SELECTED_SKILL ? 'Working under the <strong>' + (skillLabel(SELECTED_SKILL) || 'selected') + '</strong> contract. Start a new critique or pick a prompt below.' : '') + '</div>';
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
  if (!SELECTED_SKILL) { skillNoteEl.textContent = ''; skillNoteEl.className = 'skill-note'; return; }
  // If the DB is not connected the server can't read stored contracts, say so
  // instead of the misleading "no contract uploaded yet".
  if (!DB_CONNECTED && !(s && s.hasContract)) {
    skillNoteEl.textContent = '· database not connected, contracts can\u2019t load (set it in /admin, under the Advanced tab)';
    skillNoteEl.className = 'skill-note warn';
    return;
  }
  if (REINJECT_NEXT && s && s.hasContract) {
    skillNoteEl.textContent = '· contract will be applied on your next message';
    skillNoteEl.className = 'skill-note';
    return;
  }
  skillNoteEl.textContent = (s && s.hasContract) ? '· contract active' : '· no contract uploaded yet';
  skillNoteEl.className = (s && s.hasContract) ? 'skill-note' : 'skill-note warn';
}
async function loadSkills() {
  if (!skillSelectEl) return;
  try {
    const data = await (await fetch('/api/skills')).json();
    SKILLS = data.skills || [];
    if (typeof data.dbConnected === 'boolean') DB_CONNECTED = data.dbConnected;
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
  // Model picker is static metadata (API with models.json fallback), always
  // populate it so the dropdown works regardless of session/verification state.
  await loadModels();
  // Skills come from /api/skills (the admin-configured list) and aren't tied to
  // the Gumloop session, load them too so the composer's skill picker is populated.
  await loadSkills();
  const ok = await refreshStatus();
  // Always render the verification widget so the "I am human" check is visible
  // regardless of session/agent config, the site keys are served independently.
  renderCaptcha();
  if (ok) {
    loadProfile();
    await loadConversations();
    refreshCredits();
    refreshErrors();
    refreshDocuments();
  }
  setInterval(() => { refreshStatus(); refreshCredits(); refreshErrors(); refreshDocuments(); }, 20000);
})();


// ---------- sidebar collapse / mobile drawer ----------
(function () {
  const mqMobile = window.matchMedia('(max-width: 860px)');
  const toggleBtn = document.getElementById('sidebarToggle');
  const backdrop = document.getElementById('sidebarBackdrop');
  const closeDrawer = () => document.body.classList.remove('sidebar-open');

  if (toggleBtn) toggleBtn.addEventListener('click', () => {
    if (mqMobile.matches) document.body.classList.toggle('sidebar-open');
    else document.body.classList.toggle('sidebar-collapsed');
  });
  if (backdrop) backdrop.addEventListener('click', closeDrawer);
  if (typeof convListEl !== 'undefined' && convListEl) {
    convListEl.addEventListener('click', (e) => {
      if (mqMobile.matches && e.target.closest('.conv')) closeDrawer();
    });
  }
  const newChatBtn = document.getElementById('newChat');
  if (newChatBtn) newChatBtn.addEventListener('click', () => { if (mqMobile.matches) closeDrawer(); });
  mqMobile.addEventListener('change', closeDrawer); // reset drawer when crossing breakpoint
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
})();


// ---------- boot splash ----------
(function () {
  const splash = document.getElementById('splash');
  if (!splash) return;
  const start = Date.now();
  const MIN_MS = 950;   // keep the animation visible long enough to read
  const MAX_MS = 3200;  // hard cap so it never gets stuck
  let done = false;
  const hide = () => {
    if (done) return; done = true;
    const wait = Math.max(0, MIN_MS - (Date.now() - start));
    setTimeout(() => {
      splash.classList.add('is-hidden');
      setTimeout(() => splash.remove(), 600);
    }, wait);
  };
  if (document.readyState === 'complete') hide();
  else window.addEventListener('load', hide, { once: true });
  setTimeout(hide, MAX_MS);
})();


// ---------- composer file attachments ----------
let ATTACHMENTS = [];
function renderAttachments() {
  const listEl = document.getElementById('attachList');
  if (!listEl) return;
  if (!ATTACHMENTS.length) { listEl.hidden = true; listEl.innerHTML = ''; return; }
  listEl.hidden = false;
  listEl.innerHTML = ATTACHMENTS.map((a, idx) =>
    '<span class="attach-chip">'
    + '<span class="ac-ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>'
    + '<span class="ac-name">' + escH(a.filename) + '</span>'
    + '<span class="ac-size">' + bytesH(a.size) + '</span>'
    + '<button class="ac-rm" type="button" data-idx="' + idx + '" title="Remove" aria-label="Remove attachment">'
    + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    + '</button></span>'
  ).join('');
}
(function wireAttachments() {
  const fileInput = document.getElementById('fileInput');
  const attachBtn = document.getElementById('attachBtn');
  const listEl = document.getElementById('attachList');
  if (!fileInput || !attachBtn) return;
  const MAX_FILES = 8;
  const MAX_TOTAL = 5 * 1024 * 1024; // 5 MB raw -> well under the server's 8 MB JSON limit after base64

  const fileToB64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); const i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : s); };
    r.onerror = reject;
    r.readAsDataURL(file);
  });

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    for (const f of files) {
      if (ATTACHMENTS.length >= MAX_FILES) { flash('You can attach up to ' + MAX_FILES + ' files.'); break; }
      const total = ATTACHMENTS.reduce((s, a) => s + a.size, 0);
      if (total + f.size > MAX_TOTAL) { flash('Attachments exceed the 5 MB total limit.'); break; }
      try {
        const contentBase64 = await fileToB64(f);
        ATTACHMENTS.push({ filename: f.name, size: f.size, contentBase64 });
      } catch (e) { flash('Could not read ' + f.name); }
    }
    renderAttachments();
  });
  if (listEl) listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.ac-rm');
    if (!btn) return;
    const idx = parseInt(btn.getAttribute('data-idx'), 10);
    if (!isNaN(idx)) { ATTACHMENTS.splice(idx, 1); renderAttachments(); }
  });
})();

/* ============================================================
   Claude-style thinking, tool steps, file cards, and the
   slide-in document preview panel.  (Function declarations are
   hoisted, so render() above can call these freely.)
   ============================================================ */
const ICON_THINK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A4.5 4.5 0 0 0 5 6.5c0 .8.2 1.5.6 2.1A4 4 0 0 0 4 12a4 4 0 0 0 2 3.5A3.5 3.5 0 0 0 9.5 21a3 3 0 0 0 2.5-1.3V3.3A3 3 0 0 0 9.5 2Z"/><path d="M14.5 2A4.5 4.5 0 0 1 19 6.5c0 .8-.2 1.5-.6 2.1A4 4 0 0 1 20 12a4 4 0 0 1-2 3.5A3.5 3.5 0 0 1 14.5 21a3 3 0 0 1-2.5-1.3V3.3A3 3 0 0 1 14.5 2Z"/></svg>';

// One reasoning block, Claude-style: a quiet bordered card with its own header,
// muted serif body, and (while live) a soft pulsing shimmer so the user can tell
// the model is still thinking versus writing the answer.
function thinkingBlockHTML(text, open, live) {
  const cls = 'think-block' + (open ? ' open' : '') + (live ? ' is-live' : '');
  return '<details class="' + cls + '"' + (open ? ' open' : '') + '>' +
    '<summary><span class="think-ico">' + ICON_THINK + '</span>' +
    '<span class="think-label">' + (live ? 'Thinking' : 'Thought process') + '</span>' +
    '<span class="think-dot" aria-hidden="true"></span>' +
    '<span class="think-chev" aria-hidden="true"></span></summary>' +
    '<div class="think-body">' + render(text) + '</div></details>';
}

function toolStepHTML(cap, name, state) {
  const st = (state || '').toLowerCase();
  const badge = st ? '<span class="tool-state ' + escH(st) + '">' + escH(st) + '</span>' : '';
  const nm = name ? '<span class="tool-name">' + escH(name) + '</span>' : '';
  return '<div class="step step-tool"><span class="step-ico">🔧</span>' +
    '<div class="step-txt"><span class="tool-cap">' + escH(cap) + '</span>' + nm + badge + '</div></div>';
}

function stepsBlockHTML(steps, open) {
  return '<details class="agent-steps"' + (open ? ' open' : '') + '>' +
    '<summary><span class="steps-label">Steps</span>' +
    '<span class="steps-count">' + steps.length + '</span></summary>' +
    '<div class="steps-body">' + steps.join('') + '</div></details>';
}

// ---------- files: download (format-preserving) + Claude-style preview ----------
function fileExt(n) { const m = /\.([a-z0-9]+)$/i.exec(n || ''); return m ? m[1].toLowerCase() : ''; }

// Which inline preview renderer (if any) fits this file.
function previewKind(name, mt) {
  const e = fileExt(name);
  if (/pdf/i.test(mt) || e === 'pdf') return 'pdf';
  if (/(wordprocessingml|msword)/i.test(mt) || e === 'doc' || e === 'docx') return 'doc';
  if (/^image\//i.test(mt) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(e)) return 'image';
  if (/^text\//i.test(mt) || /json|markdown|xml|csv/i.test(mt) ||
      ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'tex', 'xml', 'yml', 'yaml'].includes(e)) return 'text';
  return '';
}

function fileIcon(kind) {
  if (kind === 'pdf') return '📕';
  if (kind === 'doc') return '📘';
  if (kind === 'image') return '🖼️';
  if (kind === 'text') return '📄';
  return '📎';
}

// Same-origin proxy URL so the browser can download with the right name/type
// and preview without cross-origin / X-Frame friction.
function proxyURL(url, name, extra) {
  let q = '/api/file?url=' + encodeURIComponent(url) + '&name=' + encodeURIComponent(name || 'document');
  if (extra) q += extra;
  return q;
}

// A Preview button is source-agnostic: it carries the view/html/download URLs so
// the same panel works for both thread artifacts (/api/file proxy) and stored
// documents (/api/documents/:id).
function previewBtnHTML(name, mt, kind, viewUrl, htmlUrl, dlUrl) {
  if (!kind || !viewUrl) return '';
  return '<button type="button" class="file-btn file-preview" data-name="' + escH(name) + '" data-mt="' + escH(mt || '') +
    '" data-kind="' + kind + '" data-view="' + escH(viewUrl) + '" data-html="' + escH(htmlUrl || '') + '" data-dl="' + escH(dlUrl || '') + '">Preview</button>';
}

function fileCardHTML(name, url, mt) {
  const kind = previewKind(name, mt);
  const typeLabel = mt || (fileExt(name) ? fileExt(name).toUpperCase() : 'FILE');
  const viewUrl = url ? proxyURL(url, name) : '';
  const htmlUrl = url ? proxyURL(url, name, '&as=html') : '';
  const dlUrl = url ? proxyURL(url, name, '&dl=1') : '';
  const preBtn = previewBtnHTML(name, mt, kind, viewUrl, htmlUrl, dlUrl);
  const dlBtn = url ? '<a class="file-btn file-dl" href="' + escH(dlUrl) + '">Download</a>' : '';
  return '<div class="file-card">' +
    '<span class="file-ico">' + fileIcon(kind) + '</span>' +
    '<span class="file-meta"><span class="file-name">' + escH(name) + '</span>' +
    '<span class="file-type">' + escH(typeLabel) + '</span></span>' +
    '<span class="file-actions">' + preBtn + dlBtn + '</span></div>';
}

function previewFallback(name, dlUrl) {
  return '<div class="preview-empty"><div class="preview-empty-ico">\uD83D\uDCCE</div>' +
    '<p>This file type can&rsquo;t be shown inline.</p>' +
    (dlUrl ? '<a class="file-btn file-dl" href="' + escH(dlUrl) + '">Download ' + escH(name) + '</a>' : '') +
    '</div>';
}

(function () {
  const panel = document.getElementById('previewPanel');
  const backdrop = document.getElementById('previewBackdrop');
  const body = document.getElementById('previewBody');
  const nameEl = document.getElementById('previewName');
  const typeEl = document.getElementById('previewType');
  const dlEl = document.getElementById('previewDownload');
  const closeEl = document.getElementById('previewClose');
  if (!panel || !body) return;

  function close() {
    document.body.classList.remove('preview-open');
    panel.setAttribute('aria-hidden', 'true');
    body.innerHTML = '';
  }

  function open(o) {
    const name = o.name || 'Document', mt = o.mt || '', kind = o.kind || '';
    const viewUrl = o.viewUrl || '', htmlUrl = o.htmlUrl || viewUrl, dlUrl = o.dlUrl || viewUrl;
    if (nameEl) nameEl.textContent = name;
    if (typeEl) typeEl.textContent = mt || (fileExt(name) ? fileExt(name).toUpperCase() : '');
    if (dlEl) dlEl.href = dlUrl;
    document.body.classList.add('preview-open');
    panel.setAttribute('aria-hidden', 'false');
    body.innerHTML = '<div class="preview-loading"><span class="typing"><span></span><span></span><span></span></span> Loading preview&hellip;</div>';

    if (kind === 'pdf') {
      body.innerHTML = '<iframe class="preview-frame" src="' + escH(viewUrl) + '" title="' + escH(name) + '"></iframe>';
    } else if (kind === 'image') {
      const img = new Image();
      img.className = 'preview-img';
      img.alt = name;
      img.onload = () => { body.innerHTML = ''; body.appendChild(wrapImg(img)); };
      img.onerror = () => { body.innerHTML = previewFallback(name, dlUrl); };
      img.src = viewUrl;
    } else if (kind === 'doc') {
      fetch(htmlUrl).then((r) => r.ok ? r.text() : Promise.reject()).then((html) => {
        body.innerHTML = '<div class="preview-doc">' + (html || '<p><em>Empty document.</em></p>') + '</div>';
      }).catch(() => { body.innerHTML = previewFallback(name, dlUrl); });
    } else if (kind === 'text') {
      fetch(viewUrl).then((r) => r.ok ? r.text() : Promise.reject()).then((txt) => {
        const e = fileExt(name);
        if (e === 'md' || e === 'markdown' || /markdown/i.test(mt)) {
          body.innerHTML = '<div class="preview-doc">' + render(txt) + '</div>';
        } else {
          body.innerHTML = '<pre class="preview-pre">' + escH(txt) + '</pre>';
        }
      }).catch(() => { body.innerHTML = previewFallback(name, dlUrl); });
    } else {
      body.innerHTML = previewFallback(name, dlUrl);
    }
  }
  window.PDPreview = { open };

  function wrapImg(img) { const d = document.createElement('div'); d.className = 'preview-img-wrap'; d.appendChild(img); return d; }

  // Delegated: any Preview button anywhere (thread or documents panel) opens the panel.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.file-preview');
    if (!btn) return;
    e.preventDefault();
    open({
      name: btn.getAttribute('data-name'), mt: btn.getAttribute('data-mt'), kind: btn.getAttribute('data-kind'),
      viewUrl: btn.getAttribute('data-view'), htmlUrl: btn.getAttribute('data-html'), dlUrl: btn.getAttribute('data-dl'),
    });
  });
  if (closeEl) closeEl.addEventListener('click', close);
  if (backdrop) backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('preview-open')) close(); });
})();
