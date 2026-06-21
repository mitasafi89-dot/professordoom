'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '4mb' }));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// ---- Server-side runtime state (token NEVER sent back to the client) ----
const state = {
  apiKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.DEFAULT_MODEL || 'claude-sonnet-4-20250514',
  maxTokens: parseInt(process.env.MAX_TOKENS || '4096', 10),
};

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

// ---- Load the Manuscript Writing Contract as ProfessorDoom's system prompt ----
const CONTRACT_PATH = path.join(__dirname, 'contract.txt');
let SYSTEM_PROMPT = '';
try {
  const contract = fs.readFileSync(CONTRACT_PATH, 'utf-8');
  SYSTEM_PROMPT =
    'You are ProfessorDoom, a principal co-author, methodologist, adversarial peer ' +
    'reviewer, and editor for scholarly manuscripts. You operate strictly under the ' +
    'binding Manuscript Writing Contract reproduced below. Honor every rule. ' +
    'Mediocrity, assumption, and fabrication are the only true failures.\n\n' +
    '===== MANUSCRIPT WRITING CONTRACT =====\n' +
    contract +
    '\n===== END OF CONTRACT =====';
} catch (e) {
  SYSTEM_PROMPT = 'You are ProfessorDoom, an adversarial scholarly manuscript reviewer and co-author.';
  console.error('WARNING: contract.txt not found, using fallback system prompt.');
}

// ---- Status (safe: never exposes the token) ----
app.get('/api/status', (req, res) => {
  res.json({
    configured: Boolean(state.apiKey),
    model: state.model,
    maxTokens: state.maxTokens,
  });
});

// ---- Admin: set/update the credential (held server-side only) ----
app.post('/api/admin/token', (req, res) => {
  const { password, token, model, maxTokens } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password.' });
  }
  if (typeof token === 'string' && token.trim()) {
    state.apiKey = token.trim();
  }
  if (typeof model === 'string' && model.trim()) {
    state.model = model.trim();
  }
  if (maxTokens && Number.isFinite(Number(maxTokens))) {
    state.maxTokens = Number(maxTokens);
  }
  res.json({ ok: true, configured: Boolean(state.apiKey), model: state.model, maxTokens: state.maxTokens });
});

// ---- Chat: proxy to Claude ----
app.post('/api/chat', async (req, res) => {
  if (!state.apiKey) {
    return res.status(503).json({ error: 'Backend not configured. An admin must set the Claude token in the dashboard.' });
  }
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages[] is required.' });
  }

  // Sanitize to Anthropic message shape
  const clean = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': state.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: state.model,
        max_tokens: state.maxTokens,
        system: SYSTEM_PROMPT,
        messages: clean,
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || 'Upstream error from Claude API.';
      return res.status(r.status).json({ error: msg });
    }
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    res.json({ reply: text, usage: data.usage || null, model: data.model || state.model });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reach Claude API: ' + err.message });
  }
});

// ---- Static frontend ----
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`ProfessorDoom running on http://localhost:${PORT}`);
  if (state.apiKey) console.log('Token loaded from environment.');
  else console.log('No token set yet — configure it in the admin dashboard (/admin.html).');
});
