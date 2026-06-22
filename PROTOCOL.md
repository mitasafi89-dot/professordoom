# Gumloop session, reverse-engineered protocol

Decoded from a captured HAR + live probing from the server. This is what ProfessorDoom implements.

## Auth

- **Identity provider:** Firebase Auth, project `agenthub-dev`, web API key `AIzaSyCYuXqbJ0YBNltoGS4-7Y6Hozrra8KKmaE`.
- **Durable credential:** the Firebase **refresh token** (`stsTokenManager.refreshToken` in the browser's `firebaseLocalStorageDb`).
- **Per-request credential:** a Firebase **id_token** (RS256 JWT), **60-minute** lifetime, minted from the refresh token:

```
POST https://securetoken.googleapis.com/v1/token?key=<API_KEY>
content-type: application/x-www-form-urlencoded
grant_type=refresh_token&refresh_token=<REFRESH_TOKEN>
→ { id_token, refresh_token, user_id, expires_in }
```

## REST  (`https://api.gumloop.com`)

Headers: `authorization: Bearer <id_token>`, `x-auth-key: <user_id>`, `origin: https://www.gumloop.com`, `referer: https://www.gumloop.com/`, `content-type: application/json`.

| Purpose | Request |
|---|---|
| Models | `GET /allowed_gummies_models` |
| Agents | `GET /gummies` · `GET /gummies/{id}` |
| Conversations | `GET /gummies/{id}/chat?page_size=24&sort_order=newest` |
| Message thread | `GET /gummie_interactions/{interaction_id}` → `interaction.messages[]` |
| Live queue | `GET /gummie_interactions/{id}/queue` |
| Credits | `GET /get_subscription_tier_credit_limit` |
| Set model | `GET /gummies/{id}` → edit `model_name` → `PATCH /gummies/{id}` |

Model `claude-opus-4-8` = **Claude 4.8 Opus** (Auto selector value `gummies_smartest`).

## Send a message  (WebSocket)

`wss://ws.gumloop.com/ws/gummies`, connect with `Origin: https://www.gumloop.com` (auth is in the frame, not headers). Client sends one `start` frame:

```jsonc
{
  "type": "start",
  "payload": {
    "id_token": "<Firebase id_token>",
    "context": {
      "gummie_id": "<id>",
      "interaction_id": "<existing, or a fresh client-generated id>",
      "message": { "id": "msg_<id>", "timestamp": "<ISO>",
                   "content": "<text>", "role": "user", "creator_id": "<user_id>" },
      "type": "chat", "is_incognito": false
    },
    "captcha_token":  "<hCaptcha token>",
    "captcha_provider": "hcaptcha",
    "turnstile_token": "<Cloudflare Turnstile token>"
  }
}
```

Server streams back: `interaction-ready` → `step-start` (`modelId`) → text frames → finish.

### Bot verification (the wall)

**Every message**, including follow-ups in an existing conversation, requires BOTH:
- **Cloudflare Turnstile** token (sitekey `0x4AAAAAACMum7HpvvFmcf2r`), and
- **hCaptcha** token (sitekey `5dd279d6-b56e-4dec-b474-6426c2f83150`).

Verified empirically from the server:
- No Turnstile → `{"type":"error","error":"turnstile_token_missing"}` then WS close `1008`.
- Turnstile present, bad hCaptcha → `{"type":"error","error":"hcaptcha_verification_failed"}`.

These tokens are single-use, expire in seconds, minutes, and can only be produced by a real browser solving the challenge. **There is no captcha-free or fully-automated send path.** ProfessorDoom therefore renders both widgets in the composer; the user solves them per message and the tokens are forwarded in the `start` frame.
