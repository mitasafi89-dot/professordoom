# Gumloop API & streaming protocol reference

How ProfessorDoom's server talks to Gumloop. The REST/WS contract below was
reconstructed from a captured browser session (HAR) plus the endpoints the
server actually consumes. Entries are marked **[observed]** (seen in the HAR) or
**[consumed]** (what `server/server.js` depends on). This is reference material
for maintaining the server and for keeping the test mocks production-faithful.

Hosts:
- `api.gumloop.com` — REST API (reads + chat history + account/agent data)
- `ws.gumloop.com/ws/gummies` — WebSocket the chat turn streams over
- `securetoken.googleapis.com/v1/token` — Firebase refresh-token -> id_token exchange
- `identitytoolkit.googleapis.com` — interactive Google sign-in (browser only)

## Authentication

The server holds a Firebase **refresh token** (project `agenthub-dev`) and never
exposes it to the browser. Per request it mints a short-lived **id_token**:

```
POST securetoken.googleapis.com/v1/token?key=<FIREBASE_API_KEY>
content-type: application/x-www-form-urlencoded
grant_type=refresh_token&refresh_token=<refresh_token>
-> { id_token, user_id, expires_in }   # cached until ~2 min before expiry
```

All `api.gumloop.com` calls then carry: **[consumed]**

```
authorization: Bearer <id_token>
x-auth-key:    <user_id>          # uid; also required as ?user_id= on some reads
origin/referer: https://www.gumloop.com
```

The browser auth blob (`firebase:authUser:<apiKey>:[DEFAULT]`) found in storage
contains `apiKey` and `stsTokenManager.refreshToken` — this is what `/admin`'s
"paste blob" flow extracts (see `parseAuthBlob`).

## REST endpoints

### Consumed by the server
| Method | Path | Purpose |
|---|---|---|
| GET | `/gummies` | List the account's agents (used by /admin agent detect). Returns an array (or `{data|gummies|results|items:[...]}`); each item exposes `gummie_id`/`id` + `name`. |
| GET | `/gummie_interactions/{id}` | Read back a conversation after a turn — the authoritative source for the final rendered `parts[]`. See schema below. |
| GET | `/get_subscription_tier_credit_limit?user_id={uid}` | Credit limit/remaining. |
| GET | `/user/{uid}/credit_restriction_details` | Authoritative "blocked" signal (`has_restriction`, `credit_restriction`). |
| ALL | `/api/gl/*` (server proxy) -> `api.gumloop.com/*` | Generic authenticated passthrough for the browser. |

### Other observed endpoints (not currently used — integration surface)
Account/agents: `GET /gummies/{id}`, `PATCH /gummies/{id}`, `POST /gummies`,
`GET /gummies/{id}/chat` (history), `/chat-histogram`, `/chat/filter-options`,
`/gummies/favorites`, `/most-used`, `/shared-with-me`, `/model_preferences`,
`/gummies/{id}/skills`, `/gummies/{id}/triggers`, `/gummies/{id}/template`.
Interaction: `GET /gummie_interactions/{id}/metadata`,
`/gummie_interactions/{id}/queue` (run status), `/gummie_interactions/{id}/artifacts`
(deliverables — returns `{error:"interaction_not_found"}` when absent),
`POST /gummies/{id}/context-usage` (token meter).
Account/config: `GET /project`, `/user_profile` (+`POST`), `/user_metadata`,
`/variables`, `/secret_types`, `/secrets/mcp_servers`, `/gumcp_declarations`,
`/policy/denied_keys`, `/platform_incidents`, `/capabilities`,
`/folders/tree/GUMMIE`, `POST /sign_in`.

> Every browser request is preceded by a CORS `OPTIONS` preflight (200). Mocks
> can ignore OPTIONS; the server makes server-to-server calls with no preflight.

## Interaction schema (`GET /gummie_interactions/{id}`)

```jsonc
{ "interaction": {
    "interaction_id": "...", "name": "Greeting", "state": "completed",
    "gummie_id": "...", "gummie_name": "...", "models_used": [...],
    "credit_cost": 78.0, "tool_credit_cost": ..., "stream_cursor": "...",
    "queued_messages": [...], "participants": [...],
    "messages": [
      { "role": "user",      "parts": [ ... ] },
      { "role": "assistant", "models": ["claude-opus-4-8"], "parts": [ ... ] }
    ] } }
```

`messages` may be empty (e.g. a just-created interaction). The server reads the
last `assistant` message and joins its `text` parts. **Part shapes:**

```jsonc
// text  [observed]
{ "type": "text", "id": "part_...", "streamChunkType": "text-end",
  "text": "Hi Rashdra! ...", "timestamp": "2026-06-21T14:30:52" }
// file (deliverable)  [consumed] — persistDocuments captures these
{ "type": "file", "file": { "filename": "manuscript.docx",
  "media_type": "application/vnd...wordprocessingml.document",
  "artifact_url": "https://.../artifact" } }
// tool call  [consumed] — toolName "ask_human_input" => turn is "pending"
{ "type": "tool_invocation", "toolName": "...", "toolCaption": "...",
  "toolCallState": "running|completed", "result": { ... } }
// reasoning  [observed in mock/UI]
{ "type": "reasoning", "reasoning": "..." }
```

## WebSocket turn protocol (`wss://ws.gumloop.com/ws/gummies`)

Connect with `origin: https://www.gumloop.com`. **Send** one frame to start the
turn:

```jsonc
{ "type": "start", "payload": {
    "id_token": "<id_token>",
    "context": { "gummie_id": "...", "interaction_id": "...",
      "message": { "id": "msg_...", "timestamp": "...", "content": "<text>",
                   "role": "user", "creator_id": "<uid>" },
      "type": "chat", "is_incognito": false },
    "captcha_token": "<hcaptcha>", "captcha_provider": "hcaptcha",
    "turnstile_token": "<turnstile>" } }
```

> Turnstile/hCaptcha tokens are **not** valid on localhost — a turn from
> localhost closes with WS code 1008. Serve from a real host to chat live.

**Receive** frames, in order (single-step turn):

```
interaction-ready   { interaction_id, stream_cursor }
step-start          { id, modelId: "claude-opus-4-8" }
context-usage       { conversationTokens, contextWindow }
text-start          { id: "msg-..." }
text-delta          { id, delta: "Hi" }     # repeated; text is in `delta`
... 
interaction-name-update { interactionId, name, icon }
text-end            { id }
credit-update       { credit_cost }
finish              { finishReason: "end_turn", usage: { total_tokens, ... } }
```

Key rules the server follows:
- **Accumulate** streamed text from `text-delta.delta` (older shape: `frame.text`).
- **Terminate only on `finish`** (also `interaction-finish`/`complete`/`end`).
  Multi-step turns emit `step-finish` between steps — it must **not** end the
  turn, or a multi-step agent is cut off at its first action.
- Errors arrive as `{type:"error"|"interaction-error"}` or any frame carrying
  `error`/`errorMessage`; close 1008 ~ invalid captcha.
- After the WS closes, the server does a REST reconciliation read of
  `/gummie_interactions/{id}` for the authoritative `parts[]`.

## Credit response shape (`get_subscription_tier_credit_limit`)

```jsonc
{ "credit_limit": 5000, "remaining": 6358,   // remaining can exceed limit (overage)
  "is_past_due": false, "subscription_tier": "...",
  "credit_overage_unavailable_reason": "..." }   // no "used" field; used = limit - remaining
```
Restriction (`/user/{uid}/credit_restriction_details`): `{ has_restriction, credit_restriction }`.
The UI treats the account as blocked when exhausted, restricted, or past due.

## Test harness notes

`tests/*` spawn the real `server/server.js` against an embedded mock that stands
in for the token, REST, and WS hosts (env: `GUMLOOP_API_URL`, `GUMLOOP_WS_URL`,
`FIREBASE_TOKEN_URL`). `tests/test_streaming_protocol.js` reproduces the exact
frame sequence above. Run everything with `npm test`.
