# ProfessorDoom

A professional, custom web UI on top of a **Gumloop session**. You paste your Gumloop session credentials into the admin dashboard; the server holds them in memory only and transparently proxies the browser's calls to `https://api.gumloop.com`, injecting your credentials. The frontend speaks the real Gumloop API (model picker, conversation list, message threads) and never sees the secrets.

> ⚠️ Driving a Gumloop session programmatically may conflict with Gumloop's terms of service, and session credentials expire frequently. You are responsible for your own account. See **Security & limitations** below.

## Architecture

```
Browser (chat UI)  ──►  Express proxy  ──►  https://api.gumloop.com
   model picker          injects:               (your account)
   conversation list      x-auth-key
   message threads        cookie
   composer               origin / referer
Admin dashboard ────────► holds credentials server-side only
```

## Gumloop API surface (decoded from a captured session)

| Purpose | Request |
|---|---|
| Auth | header `x-auth-key: <your user id>` + session `cookie` |
| Required headers | `origin: https://www.gumloop.com`, `referer: https://www.gumloop.com/`, `content-type: application/json` |
| Model list | `GET /allowed_gummies_models` |
| Your agents | `GET /gummies` · `GET /gummies/{id}` |
| Conversation list | `GET /gummies/{id}/chat?page_size=24&sort_order=newest` |
| Message thread | `GET /gummie_interactions/{interaction_id}` → `interaction.messages[]` |
| Live queue | `GET /gummie_interactions/{id}/queue` |
| Profile / project | `GET /user_profile` · `GET /project` |
| **Send a message** | **Not in the sample capture — configure it in Admin (see below).** |

Models available through the session include **Claude 4.8 Opus** (`claude-opus-4-8`, selector value `gummies_smartest`), the full Anthropic/OpenAI/Google/DeepSeek/etc. line-up, plus the Auto group (Recommended / Smartest / Fastest). The live list is fetched from `/allowed_gummies_models`; `public/models.json` is a bundled fallback.

### Message shape

```jsonc
{
  "role": "user",      "content": "Hi", "parts": []
}
{
  "role": "assistant", "models": ["claude-opus-4-8"],
  "parts": [ { "type": "text", "text": "Hi Rashdra! ...", "streamChunkType": "text-end" } ],
  "usage": { ... }, "totalCredits": 78.0
}
```

## Run locally

```bash
npm install
cp .env.example .env   # optional
npm start
# open http://localhost:3000  →  go to /admin.html to paste your session
```

## Configure the session (admin dashboard)

1. Open `/admin.html`, enter the admin password.
2. Paste your **x-auth-key** (your Gumloop user id) and the full **session cookie** string.
3. Set the **Gummie ID** of the agent you want to drive.
4. Save. The chat UI now lists your conversations and renders message threads live.

### Enabling "send"

The send-message request was not in the sample HAR. To enable sending:

1. Open Gumloop, open DevTools → Network (Fetch/XHR), send one message.
2. Find the request that carries your prompt. Note its **method**, **path**, and **body**.
3. In Admin → *Advanced: send-message endpoint*, set the method and path (use `{gummieId}` as a placeholder, e.g. `gummies/{gummieId}/start`).
4. If the body shape differs from `{ message, model, interaction_id }`, tell the maintainer so `app.js`/`/api/send` can be aligned to it.

## Security & limitations

- Credentials live **only in server memory** and are never returned to any client (the frontend reads a boolean status only). Use *Clear stored session* in Admin to wipe them.
- **Sessions expire** (often within hours). When calls start returning `401/403`, re-paste a fresh cookie.
- This replays your logged-in session against an undocumented internal API; it is **brittle by design** and may violate Gumloop's ToS.
- **Change `ADMIN_PASSWORD`** before deploying anywhere public. Never commit your `.env` (git-ignored).

## Project layout

```
server/server.js   Express proxy + admin endpoints
public/index.html  chat client (sidebar, model picker, thread, composer)
public/app.js       client logic
public/admin.html   session dashboard
public/styles.css   UI styling
public/models.json  fallback model list
Manuscript-Writing-Contract.docx + server/contract.txt   committed contract
```

## License

MIT — see [LICENSE](LICENSE).
