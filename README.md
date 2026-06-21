# ProfessorDoom

A professional web app whose back-engine is **Claude (Anthropic)**. ProfessorDoom acts as a principal co-author, methodologist, and **adversarial peer reviewer**, operating under the binding **Manuscript Writing Contract** (included in this repo) as its system prompt. Its target: engineer a manuscript so that *rejecting it is expensive and accepting it is cheap*.

## Architecture

```
Browser (chat UI)  ──►  Express server  ──►  Anthropic Messages API
                         │  holds token (server-side only)
                         │  injects the contract as the system prompt
Admin dashboard ────────►┘  (POST /api/admin/token, password-gated)
```

- **`public/index.html`** — modern chat interface.
- **`public/admin.html`** — admin dashboard where the admin pastes the Claude token.
- **`server/server.js`** — Express backend; proxies chat to Claude and never exposes the token to the browser.
- **`server/contract.txt`** — the Manuscript Writing Contract, loaded as the system prompt.
- **`Manuscript-Writing-Contract.docx`** — the original contract document.

## Run locally

```bash
npm install
cp .env.example .env   # optional: set token/password here
npm start
# open http://localhost:3000
```

Then either set `ANTHROPIC_API_KEY` in `.env`, **or** open `/admin.html`, enter the admin password, and paste the token there.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude credential (recommended: real Anthropic API key) | _empty_ |
| `DEFAULT_MODEL` | Claude model | `claude-sonnet-4-20250514` |
| `MAX_TOKENS` | Max tokens per reply | `4096` |
| `ADMIN_PASSWORD` | Gate for the admin dashboard | `changeme` |
| `PORT` | Server port | `3000` |

## Security notes

- The token is held **only in server memory** and is never returned to any client. The frontend can only read a boolean "configured" status.
- **Change `ADMIN_PASSWORD`** before deploying anywhere public.
- Prefer a **real Anthropic API key** (`x-api-key`). A `claude.ai` session token is unofficial, breaks frequently, and may violate Anthropic's terms of service.
- Never commit your `.env` (it is git-ignored).

## License

MIT — see [LICENSE](LICENSE).
