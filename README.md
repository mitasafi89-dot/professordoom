# ProfessorDoom

A professional, custom web UI on top of a **Gumloop session**. The back-engine is your own Gumloop account (models up to **Claude 4.8 Opus**). You store a Firebase **refresh token** in the admin dashboard; the server mints short-lived `id_token`s from it, proxies your REST reads, and sends chat messages over Gumloop's WebSocket. Secrets stay server-side.

> The full reverse-engineered protocol is documented in **[PROTOCOL.md](PROTOCOL.md)**.

## How it works

```
Browser (chat UI)            Express server                 Gumloop
 model picker / threads  ──►  mint id_token (refresh) ──►   api.gumloop.com (REST reads)
 Turnstile + hCaptcha    ──►  open WebSocket + send   ──►   ws.gumloop.com/ws/gummies
 (solved per message)         (forwards captcha tokens)
```

- **Auth** — a Firebase refresh token (project `agenthub-dev`) is held server-side; `id_token`s (60-min) are minted on demand.
- **Reading** — `/api/gl/*` transparently proxies any `api.gumloop.com` endpoint with your bearer token injected.
- **Sending** — `/api/send` mints a token, opens `wss://ws.gumloop.com/ws/gummies`, and sends a `start` frame with your message + the captcha tokens the UI collected. The final reply is fetched authoritatively from `GET /gummie_interactions/{id}`.

## ⚠️ The captcha reality

Gumloop enforces **bot verification on every message** — Cloudflare **Turnstile** *and* **hCaptcha** — server-side. These tokens are single-use and can only be produced by a real browser solving the challenge. So ProfessorDoom renders both widgets in the composer; **you solve them for each message** and the tokens are forwarded over the WebSocket. There is no fully-automated send path (verified empirically — see PROTOCOL.md).

## Run locally

```bash
npm install
cp .env.example .env   # optional
npm start
# open http://localhost:3000  →  /admin to paste your refresh token
```

## Configure (admin dashboard)

1. Open `/admin`, enter the admin password.
2. Paste your Firebase **refresh token** (`stsTokenManager.refreshToken` from DevTools → Application → IndexedDB → `firebaseLocalStorageDb`).
3. Set the **Gummie ID** of the agent to drive.
4. Click **Verify session** to confirm it mints a token and authenticates.

Then on the chat page: pick a conversation (or New chat), solve the verification widgets, type, and send.

## Security & limitations

- The refresh token lives **only in server memory** and is never returned to any client. Use *Clear stored session* to wipe it.
- Refresh tokens are revoked when you sign out of Gumloop; re-paste a new one when verification fails.
- This replays your logged-in session against an undocumented internal API and **may conflict with Gumloop's terms of service**. You are responsible for your own account.
- **Change `ADMIN_PASSWORD`** before deploying. Never commit `.env` (git-ignored).

## Project layout

```
server/server.js   Express: token minting, REST proxy, WebSocket send
public/index.html  chat client (sidebar, model picker, thread, captcha composer)
public/app.js       client logic + captcha widgets
public/admin.html   admin dashboard (served at /admin)
public/styles.css   UI styling
public/models.json  fallback model list
PROTOCOL.md         reverse-engineered Gumloop protocol
Manuscript-Writing-Contract.docx + server/contract.txt   committed contract
```

## License

MIT — see [LICENSE](LICENSE).
