# ProfessorDoom, System Assessment & Phased Plan

A rigorous, first-principles review of the current system, what works, what is
partial, what is missing, and the phased plan to address every issue.

## 1. How the underlying system actually works (mirrored)

ProfessorDoom is a custom UI in front of a **Gumloop agent session**. There is no
private API, the server reverse-implements the browser's own protocol:

- **Auth**: a Firebase *refresh token* (project `agenthub-dev`) is held
  server-side. The server mints short-lived *id_tokens* (60 min, RS256) from it
  via `POST securetoken.googleapis.com/v1/token`.
- **Reads (REST)**: `api.gumloop.com` with `Authorization: Bearer <id_token>` +
  `x-auth-key: <uid>`, models, agents, conversation list, and the full message
  thread (`/gummie_interactions/{id}` → `interaction.messages[]`, each with
  `parts[]` of type `reasoning | tool_invocation | text | file`).
- **Send (WebSocket)**: `wss://ws.gumloop.com/ws/gummies`. The client sends one
  `start` frame carrying the id_token, the gummie/interaction ids, the message,
  and **both** captcha tokens. The server streams frames back:
  `interaction-ready → step-start → (reasoning / tool / text deltas) → finish`.
- **The captcha wall**: EVERY message (incl. follow-ups) needs a browser-solved
  Cloudflare Turnstile token **and** an hCaptcha token. They are single-use and
  short-lived. **There is no automated/captcha-free send path**, this is a hard
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
- **Turn delivery**: works, but is BLOCKING, the browser waits for the whole
  turn then renders it at once. Frames are streamed to the server and discarded.
- **Conversation sidebar**: functional list, but flat, no grouping, relative
  time, search, active/loading states, or refined visual design.
- **Contract injection**: only on the first message of a NEW conversation.

### Missing
- **Live streaming to the browser** (the core of both reported issues).
- **Live background activity**: thinking, current tool/step, loading, streaming
  text, none of it is surfaced while the turn is in flight.
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

- **Phase 1, Live streaming backend.** New `POST /api/send/stream` (SSE). Opens
  the Gumloop WS, forwards each frame as an SSE `frame` event, then emits a final
  `done` event carrying the authoritative REST `parts[]`. Heartbeats, client-
  disconnect teardown, 150 s safety timeout, graceful error events. Gumloop
  endpoints (`API`, `WS_URL`, token URL) made env-overridable for self-hosting
  and testing. *(addresses: conversation continuity + background activity)*
- **Phase 2, Live activity UI.** Rewrite the composer send path to consume the
  SSE stream: a live "Thinking & steps" panel that fills in as frames arrive, a
  streaming answer, and a status line (Thinking… / Running <tool>… / Writing…).
  Authoritative re-render on `done`. *(addresses: background visibility)*
- **Phase 3, Conversation sidebar redesign.** Date grouping (Today/Yesterday/
  Earlier), relative timestamps, active + hover states, live filter/search,
  loading skeletons, refined visual design consistent with the brand.
- **Phase 4, E2E test harness.** A mock Gumloop server (token + REST + WS)
  emitting realistic frames, driven through our server and a headless browser, to
  prove the full stream → render pipeline. Plus endpoint smoke tests.
- **Phase 5, Hardening & polish.** Stop/cancel a turn, reconnect on drop,
  optional skill re-injection on demand, accessibility, and final review.

Each phase is committed to `main` before the next begins.


## 5. Implementation status, all phases complete

- **Phase 1 ✅** Live SSE streaming backend (`POST /api/send/stream`).
- **Phase 2 ✅** Live activity UI, thinking/tool steps + status line, authoritative re-render on `done`.
- **Phase 3 ✅** Redesigned sidebar, search, date grouping, relative times, state badges, skeletons.
- **Phase 4 ✅** E2E harness (`tests/mock_gumloop.js` + headless browser).
- **Phase 5 ✅** Hardening:
  - **Stop/cancel**, the composer button becomes a Stop control mid-turn; aborting the
    fetch closes the SSE stream and tears down the upstream Gumloop WS; partial output is kept.
  - **Drop recovery**, if the stream drops before `done`, the client polls the REST
    interaction a few times and renders the completed turn.
  - **On-demand contract re-injection**, changing the working skill mid-conversation
    re-applies the contract on the next message (`reinject`); a brand-new chat injects
    automatically; without it, existing conversations are left untouched.

All verified end-to-end against the mock Gumloop server through a headless browser. The
only path not exercisable from CI is a real captcha-gated live send (no captcha-free path
exists); the full stream→render pipeline is proven against a faithful mock.

## 6. Phase 6, Auto-continue (no manual "continue") ✅

**Problem.** The agent ends each turn and the user had to type "continue", and
re-solve the captcha, to keep a long, multi-phase task moving. Two frictions:
typing, and the single-use captcha. The captcha wall is unavoidable (Gumloop
validates a real hCaptcha token per message), so the goal is to remove the
typing and mint fresh tokens with as little human action as possible.

**Solution (reuses existing primitives).**
- **Server.** When the browser sends `autocontinue: true`, a short *AUTONOMOUS
  MODE* directive is prepended to the outgoing message (same injection path as
  the working contract). It tells the agent to work straight through the whole
  task across turns and to end its FINAL message with the exact token
  `⟦TASK_COMPLETE⟧` only when truly done, or to use `ask_human_input` if it
  needs a decision. The streaming `done` event now also reports two authoritative
  booleans: `complete` (sentinel present in the reconciled reply) and `pending`
  (an `ask_human_input` tool part is present).
- **Client.** hCaptcha + Turnstile render in **invisible** mode so a *fresh*,
  single-use token is minted programmatically (`executeCaptcha()`) for every turn
manual or automatic, with no extra clicking in the common low-risk case
  (hCaptcha only surfaces a visible challenge when it insists). An **Auto-continue**
  toggle (persisted) drives a loop: after each turn the client auto-resends
  "continue" until `complete`, a `pending` question, an error, the user pressing
  Stop, or a safety cap (`AUTO_CAP`, default 25). The completion sentinel is
  stripped from the rendered text; auto-sent "continue" turns are marked subtly.

**Verified** (`tests/test_autocontinue.js` + headless-browser loop test):
directive injection, `complete`/`pending` detection, and a real loop where one
user message drives multiple turns and stops on `⟦TASK_COMPLETE⟧` with zero
human typing and zero page errors.

## 7. Phase 7, Stall-proofing + honest turn status ✅

**Problem.** A long manuscript run (see `docs/SESSION_ANALYSIS_SME.md`) exposed
that auto-continue, though built, was OFF by default — so the user typed
"continue" ~25 times. Worse, the agent fragmented work across turns: eight
near-identical "now I'm writing the manuscript" announcements with no file in
between, a wall of `(no content)` bubbles, tool chips frozen at `pending`, and
deliverables that were never exported as artifacts (so they couldn't be
downloaded/previewed).

**Solution.**
- **Auto-continue ON by default** (explicit `0` still respected). Long contract
  work drives itself; safety cap + Stop unchanged.
- **Stall guard** (`STALL_CAP`, default 3): the loop breaks after N consecutive
  no-progress turns with an actionable note, instead of spinning to the cap.
  `runTurn` reports `outcome.empty` from the authoritative `done` parts.
- **`pending` reconciliation**: on the final re-render, non-terminal tool states
  are normalised to a neutral `done` — no more false "stuck" spinners.
- **`(no content)` → honest muted note** instead of a dead bubble.
- **Hardened AUTONOMOUS directive**: forbids re-announcement stalls ("if you're
  about to write it, write it this turn"; "never repeat the same next-step
  sentence") and makes artifact export mandatory before `⟦TASK_COMPLETE⟧` (a
  file that lives only in the sandbox has not been delivered).

**Verified** by the existing `tests/test_autocontinue.js` (all assertions green,
including the no-typing browser loop) after the changes.

## 8. Phase 8, Credit visibility + error surfacing ✅

**Problem.** Two blind spots: there was no way to see how Gumloop credits were
being consumed or to know when they were exhausted, and Gumloop-side failures
(auth, REST, WebSocket, no-output, credit limits) were only ever visible inline
in a single failed turn — easy to miss, impossible to review after the fact.

**Solution.**
- **Credits.** `GET /api/credits` mints a token, calls Gumloop's
  `get_subscription_tier_credit_limit`, and normalizes the (uncontracted) payload
  defensively — a depth-limited walk matches the usual `used`/`limit`/`remaining`
  key namings and derives whichever piece is missing, then computes `exhausted`.
  Cached briefly (`CREDIT_CACHE_MS`, default 15s) so the polling UI doesn't hammer
  upstream. The header shows a live **credits meter** (bar + "N / M left") that
  turns amber when low and red when exhausted; on exhaustion the composer is
  blocked, the auto-continue loop stops, and a banner explains why.
- **Errors.** A server-side ring buffer (`recordError`, last 30) captures failures
  from the auth mint, REST proxy, the send WebSocket, no-output diagnostics, and
  credit checks, each tagged with source/code and a `credit` flag. `GET /api/errors`
  serves them; `POST /api/errors/clear` empties them. The header gets an **errors
  bell** with a live count and a dropdown log (source, time, message) so nothing
  fails silently. Credits + errors refresh on load, every 20s, and after every turn.

**Verified** by `tests/test_credits_errors.js` (credit normalization across flat,
remaining-only, exhausted, and nested payload shapes; WS-error capture; credit
flagging; clear) and the existing `tests/test_autocontinue.js` (UI loads with the
new header controls and **zero page errors**).

### 8a. Phase 8 correction, real credit endpoint shape (from HAR) ✅

The first cut of `/api/credits` guessed the upstream contract. A captured HAR
pinned down the truth and exposed a real bug:

- The endpoint **requires** `?user_id={uid}` — the first version omitted it.
- The real response is `{ credit_limit, remaining, is_past_due,
  credit_overage_unavailable_reason, pending_credit_limit, ... }`. There is **no
  `used` field** (it's derived as `limit - remaining`, floored at 0), and
  `remaining` can **exceed** `credit_limit` via overage/rollover (e.g. 6358/5000).
- A second endpoint, `GET /user/{uid}/credit_restriction_details`
  (`{ has_restriction, credit_restriction, remaining, ... }`), is the
  authoritative "blocked" signal.

Fixes: pass `user_id`; parse the real fields precisely (keeping the generic
walk as a fallback for unknown shapes); fetch restriction details in parallel;
expose `pastDue`, `restricted`, `restrictionReason`, and a single `blocked`
flag. The meter is now a **depleting "remaining" bar** (full = healthy, capped at
100% when remaining > limit), and the composer/auto-loop stop on `blocked`
(exhausted OR restricted OR past-due), with the reason shown in the banner.
Verified against the exact HAR shape in `tests/test_credits_errors.js`.

## 9. Phase 9, Processed-document persistence + library ✅

**Problem.** Deliverables only existed as `file` parts on a single message,
pointing at Gumloop artifact URLs that can expire. There was no durable, browsable
record of what the agent produced across a long, multi-phase task, and no single
place to download/preview each phase's output.

**Research.** Postgres `bytea` (TOAST-backed) is the right fit for small/moderate
binaries with simple SQL CRUD; large objects/Supabase Storage buckets are only
warranted for very large or CDN-delivered media. Since the app has only a
`DATABASE_URL` (no Storage bucket credentials) and deliverables are a few MB,
`bytea` keeps the feature self-contained — chosen with a 25MB inline cap (larger
files keep metadata + the live URL) and an in-memory fallback when no DB.

**Solution.**
- **Schema.** New `pd_documents(id, interaction_id, conversation_name, filename,
  media_type, artifact_url, bytes, version, content bytea, created_at, updated_at)`.
  `id = sha1(interaction_id|filename)` so a re-export upserts in place and bumps
  `version`; a new filename is a new row.
- **Capture.** On each finished turn, `persistDocuments()` scans the authoritative
  `parts[]` for `file` artifacts, fetches the bytes once (idempotent: same URL is
  skipped, a new URL replaces + versions), and stores them. Fire-and-forget so it
  never delays the `done` event; failures are logged to the error feed.
- **Serve.** `GET /api/documents[?interaction_id=]` lists the library;
  `GET /api/documents/:id` streams bytes from the DB (`?dl=1` download,
  `?as=html` Word to HTML via mammoth), falling back to proxying the live artifact
  URL for files too big to store inline.
- **UI.** A header **Documents** button (folder icon + count badge) opens a panel
  listing saved deliverables (This chat / All), each with **Preview** and
  **Download**. The preview panel was refactored to be source-agnostic (carries
  view/html/download URLs) so the exact same panel renders both thread artifacts
  and stored documents.
- **Security.** Artifact fetches still go through `safeArtifactUrl` (SSRF guard);
  a default-OFF `PD_ALLOW_LOCAL_FETCH=1` opt-in covers same-origin self-hosting
  and the test harness.

**Verified** by `tests/test_documents.js` (capture, durable byte-exact download +
inline serve, idempotency, versioning, and a second deliverable) plus the existing
auto-continue and credits/errors suites (UI loads with the new controls, zero page
errors).

## 10. Phase 10, Dark theme

Opt-in dark theme; light remains the default. The UI is variable-driven, so dark
mode is mainly a remap of the `:root` custom properties under
`[data-theme="dark"]` on `<html>`, plus explicit overrides for the few hardcoded
light values (scrollbar thumb, the translucent topbar, conversation/nav/option
hover+active tints). Document and image previews keep a white "paper" background
for readability.

- No flash: an inline `<head>` script applies the saved theme before first paint
  (`localStorage.pd_theme`, default light).
- Toggle: a sun/moon button in the sidebar footer flips and persists the theme.
- Palette: deep teal-tinted slate surfaces, brightened brand for contrast,
  dark-tinted status backgrounds, deeper shadows, and `color-scheme: dark`.

Verified: the headless-browser test loads the page with the new head script and
toggle wiring with zero page errors; light and dark both render and the toggle
flips/persists `data-theme`.
