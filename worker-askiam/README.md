# worker-askiam — AskIAM Bot

A Cloudflare Worker that answers natural-language IBM Verify IAM queries in Slack via the
`/askiam` slash command. Uses IBM Verify OAuth 2.0 Authorization Code + PKCE so every Slack
user authenticates with their own IBM Verify identity — tokens are cached in KV and
auto-refreshed.

**Live Worker:** `https://askiam-bot.baronia.workers.dev`  
**Slack command:** `/askiam`  
**Tenant:** `baronia.verify.ibm.com`

---

## Architecture

```
/askiam count users
        │
        ▼
POST /slack/command  (Worker)
        │
        ├─ Token in KV for this Slack user_id?
        │
        ├── YES → routeQuery() → Gemini picks MCP tool + args
        │              └── callTool() → mcp.baronia.work (IBM Verify APIs)
        │                      └── answerQuery() → Gemini summarises → Slack
        │
        └── NO → generate PKCE challenge → store {userId, verifier, query, response_url}
                  in KV (state:<nonce>, 5-min TTL) → reply with IBM Verify login link
                          │
                          ▼
                  User authenticates at baronia.verify.ibm.com
                          │
                          ▼
                  GET /oauth/callback?code=...&state=...
                          ├─ Exchange code for tokens
                          ├─ Store access_token + refresh_token in KV (token:<user_id>)
                          └─ Fire original query → result posted to Slack
```

---

## File Map

```
worker-askiam/
├── index.js                    Main Worker — /slack/command, /oauth/callback, /health
├── wrangler.toml               Worker name, KV binding (ASKIAM_TOKENS)
├── slack-app-manifest.yaml     Slack app manifest
├── slack-app-manifest.json     Same manifest in JSON (use if YAML is rejected by Slack)
├── .dev.vars.example           Secret template
├── package.json                wrangler@4
└── shared/
    ├── gemini.js               routeQuery() + answerQuery() — Gemini 3.5 Flash Lite
    └── mcp-client.js           callTool() — POSTs to mcp.baronia.work with user Bearer token
```

---

## Deploy

```bash
cd worker-askiam
npm install
npx wrangler kv namespace create ASKIAM_TOKENS   # first time only — paste id into wrangler.toml
npx wrangler deploy
```

---

## Secrets

```bash
cd worker-askiam
npx wrangler secret put VERIFY_CLIENT_ID      # Subject app client ID (auth-code + PKCE)
npx wrangler secret put VERIFY_CLIENT_SECRET
npx wrangler secret put SLACK_SIGNING_SECRET  # from Slack app Basic Information
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put WORKER_BASE_URL       # https://askiam-bot.baronia.workers.dev
```

| Secret | Value / Notes |
|--------|--------------|
| `VERIFY_CLIENT_ID` | `363515bd-3987-444f-84c4-b0e023b09763` — MCP Server Subject app |
| `VERIFY_CLIENT_SECRET` | Subject app secret |
| `SLACK_SIGNING_SECRET` | From AskIAM Slack app → Basic Information |
| `GEMINI_API_KEY` | From Google AI Studio |
| `WORKER_BASE_URL` | `https://askiam-bot.baronia.workers.dev` |
| KV `ASKIAM_TOKENS` | Stores OAuth tokens per Slack `user_id` |

---

## IBM Verify Setup

Add this redirect URI to the **MCP Server Subject** app (`363515bd`) in the IBM Verify
Admin Console → Applications → edit → Redirect URIs:

```
https://askiam-bot.baronia.workers.dev/oauth/callback
```

---

## Slack App Setup

1. **https://api.slack.com/apps** → **Create New App** → **From an app manifest**
2. Use the **JSON** tab — paste [`slack-app-manifest.json`](slack-app-manifest.json)
3. Install to workspace → copy **Signing Secret** → push as `SLACK_SIGNING_SECRET`
4. **Interactivity & Shortcuts** — leave OFF (no buttons in this bot)

---

## Example Queries

```
/askiam count all users
/askiam list users in Engineering
/askiam show user john@example.com
/askiam list all groups
/askiam count groups
/askiam list applications
/askiam show MFA enrollments for 644002HTEZ
/askiam list all MFA enrollments
```

---

## Token Lifecycle

| Event | Behaviour |
|-------|-----------|
| First `/askiam` | No token → send IBM Verify login link (PKCE, 5-min TTL) |
| After login | Token stored in KV under `token:<slack_user_id>` |
| Access token rejected (401) | Auto-refresh using stored refresh token |
| Refresh token expired | Delete KV entry → prompt re-authentication |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Auth link shows `redirect_uri_mismatch` | Add `https://askiam-bot.baronia.workers.dev/oauth/callback` to IBM Verify Subject app redirect URIs |
| `Authentication session expired` on callback | PKCE state TTL is 5 min — run `/askiam` again and click promptly |
| `401 Unauthorized` from MCP server | Subject app not entitled for that Slack user — check Admin Console → Entitlements |
| Token keeps expiring | Refresh token revoked — click the auth link once to renew |
| Gemini routing fails silently | Check `GEMINI_API_KEY`; try a more explicit query like `/askiam count all users` |
