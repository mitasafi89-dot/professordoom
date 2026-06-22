# ProfessorDoom — System Assessment & Phased Plan

A rigorous, first-principles review of the current system, what works, what is
partial, what is missing, and the phased plan to address every issue.

## 1. How the underlying system actually works (mirrored)

ProfessorDoom is a custom UI in front of a **Gumloop agent session**. There is no
private API — the server reverse-implements the browser's own protocol:

- **Auth**: a Firebase *refresh token* (project `agenthub-dev`) is held
  server-side. The server mints short-lived *id_tokens* (60 min, RS256) from it
  via `POST securetoken.googleapis.com/v1/token`.
- **Reads (REST)**: `api.gumloop.com` with `Authorization: Bearer <id_token>` +
  `x-auth-key: <uid>` — models, agents, conversation list, and the full message
  thread (`/gummie_interactions/{id}` → `interaction.messages[]`, each with
  `parts[]` of type `reasoning | tool_invocation | text | file`).
- **Send (WebSocket)**: `wss://ws.gumloop.com/ws/gummies`. The client sends one
  `start` frame carrying the id_token, the gummie/interaction ids, the message,
  and **both** captcha tokens. The server streams frames back:
  `interaction-ready → step-start → (reasoning / tool / text deltas) → finish`.
- **The captcha wall**: EVERY message (incl. follow-ups) needs a browser-solved
  Cloudflare Turnstile token **and** an hCaptcha token. They are single-use and
  short-lived. **There is no automated/captcha-free send path** — this is a hard
  constraint we must design around, not remove.
- **Persistence**: Postgres/Supabase (`pd_config`, `pd_messages`, `pd_skills`) is
  the source of truth; env vars only seed first boot. (Plus a local-file fallback
  added in the previous milestone so settings survive a DB outage.)

## 2. Status ledger

### Done
- Server-side token minting, REST proxy, conversation/thread read & render.
- Durable config + skills persistence (Supabase + local-file fallback).
- Skills fetched live from Supabase; contract auto-injected on a NEW conversation.
- Optional/!off-by-default admin password; one-paste autonomous setup.
- Static rendering of a finished turn's `parts[]` (thinking, tool chips, files).

### Partial
- **Turn delivery**: works, but is BLOCKING — the browser waits for the whole
  turn then renders it at once. Frames are streamed to the server and discarded.
- **Conversation sidebar**: functional list, but flat — no grouping, relative
  time, search, active/loading states, or refined visual design.
- **Contract injection**: only on the first message of a NEW conversation.

### Missing
- **Live streaming to the browser** (the core of both reported issues).
- **Live background activity**: thinking, current tool/step, loading, streaming
  text — none of it is surfaced while the turn is in flight.
- **Continuity affordances**: status line, stop/cancel, reconnect on drop.
- **Automated E2E coverage** of the send/stream pipeline.

## 3. Why "the conversation ends after every message"

It is the blocking architecture, not a lost conversation. `interaction_id` is
correctly reused, so context persists. But the UX is: send → static typing dot
for up to 150 s → whole turn appears → re-solve captcha. Nothing live happens in
between, so each message reads as an isolated, terminating round-trip.

**Fix:** stream the turn. Forward every Gumloop WS frame to the browser over
Server-Sent Events; render reasoning/tool/text live; reconcile against the
authoritative REST `parts[]` at the end. Keep `interaction_id` reuse for context.

## 4. Phased plan

- **Phase 1 — Live streaming backend.** New `POST /api/send/stream` (SSE). Opens
  the Gumloop WS, forwards each frame as an SSE `frame` event, then emits a final
  `done` event carrying the authoritative REST `parts[]`. Heartbeats, client-
  disconnect teardown, 150 s safety timeout, graceful error events. Gumloop
  endpoints (`API`, `WS_URL`, token URL) made env-overridable for self-hosting
  and testing. *(addresses: conversation continuity + background activity)*
- **Phase 2 — Live activity UI.** Rewrite the composer send path to consume the
  SSE stream: a live "Thinking & steps" panel that fills in as frames arrive, a
  streaming answer, and a status line (Thinking… / Running <tool>… / Writing…).
  Authoritative re-render on `done`. *(addresses: background visibility)*
- **Phase 3 — Conversation sidebar redesign.** Date grouping (Today/Yesterday/
  Earlier), relative timestamps, active + hover states, live filter/search,
  loading skeletons, refined visual design consistent with the brand.
- **Phase 4 — E2E test harness.** A mock Gumloop server (token + REST + WS)
  emitting realistic frames, driven through our server and a headless browser, to
  prove the full stream → render pipeline. Plus endpoint smoke tests.
- **Phase 5 — Hardening & polish.** Stop/cancel a turn, reconnect on drop,
  optional skill re-injection on demand, accessibility, and final review.

Each phase is committed to `main` before the next begins.


## 5. Implementation status — all phases complete

- **Phase 1 ✅** Live SSE streaming backend (`POST /api/send/stream`).
- **Phase 2 ✅** Live activity UI — thinking/tool steps + status line, authoritative re-render on `done`.
- **Phase 3 ✅** Redesigned sidebar — search, date grouping, relative times, state badges, skeletons.
- **Phase 4 ✅** E2E harness (`tests/mock_gumloop.js` + headless browser).
- **Phase 5 ✅** Hardening:
  - **Stop/cancel** — the composer button becomes a Stop control mid-turn; aborting the
    fetch closes the SSE stream and tears down the upstream Gumloop WS; partial output is kept.
  - **Drop recovery** — if the stream drops before `done`, the client polls the REST
    interaction a few times and renders the completed turn.
  - **On-demand contract re-injection** — changing the working skill mid-conversation
    re-applies the contract on the next message (`reinject`); a brand-new chat injects
    automatically; without it, existing conversations are left untouched.

All verified end-to-end against the mock Gumloop server through a headless browser. The
only path not exercisable from CI is a real captcha-gated live send (no captcha-free path
exists); the full stream→render pipeline is proven against a faithful mock.

## 6. Phase 6 — Auto-continue (no manual "continue") ✅

**Problem.** The agent ends each turn and the user had to type "continue" — and
re-solve the captcha — to keep a long, multi-phase task moving. Two frictions:
typing, and the single-use captcha. The captcha wall is unavoidable (Gumloop
validates a real hCaptcha token per message), so the goal is to remove the
typing and mint fresh tokens with as little human action as possible.

**Solution (reuses existing primitives).**
- **Server.** When the browser sends `autocontinue: true`, a short *AUTONOMOUS
  MODE* directive is prepended to the outgoing message (same injection path as
  the working contract). It tells the agent to work straight through the whole
  task across turns and to end its FINAL message with the exact token
  `⟦TASK_COMPLETE⟧` only when truly done — or to use `ask_human_input` if it
  needs a decision. The streaming `done` event now also reports two authoritative
  booleans: `complete` (sentinel present in the reconciled reply) and `pending`
  (an `ask_human_input` tool part is present).
- **Client.** hCaptcha + Turnstile render in **invisible** mode so a *fresh*,
  single-use token is minted programmatically (`executeCaptcha()`) for every turn
  — manual or automatic — with no extra clicking in the common low-risk case
  (hCaptcha only surfaces a visible challenge when it insists). An **Auto-continue**
  toggle (persisted) drives a loop: after each turn the client auto-resends
  "continue" until `complete`, a `pending` question, an error, the user pressing
  Stop, or a safety cap (`AUTO_CAP`, default 25). The completion sentinel is
  stripped from the rendered text; auto-sent "continue" turns are marked subtly.

**Verified** (`tests/test_autocontinue.js` + headless-browser loop test):
directive injection, `complete`/`pending` detection, and a real loop where one
user message drives multiple turns and stops on `⟦TASK_COMPLETE⟧` with zero
human typing and zero page errors.
