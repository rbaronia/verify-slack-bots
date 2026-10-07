# worker-askiam — AskIAM Bot

A Cloudflare Worker that answers natural-language IBM Verify IAM queries in Slack via the
`/askiam` slash command. Uses IBM Verify OAuth 2.0 Authorization Code + PKCE so every Slack
user authenticates with their own IBM Verify identity — tokens are cached in KV and
auto-refreshed.

**Live Worker:** `https://askiam-bot.baronia.workers.dev`  
**Slack command:** `/askiam`  
**Tenant:** `baronia.verify.ibm.com`  
**MCP server:** `https://mcp.baronia.work/mcp`

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
├── .dev.vars.example           Secret template — copy to .dev.vars for local dev
├── package.json                wrangler@4
└── shared/
    ├── gemini.js               routeQuery() + answerQuery() — Gemini 3.5 Flash Lite
    └── mcp-client.js           callTool() — MCP Streamable HTTP session + tools/call
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

Set all secrets with `npx wrangler secret put <NAME>` from the `worker-askiam/` directory,
or paste them into `.dev.vars` (copied from `.dev.vars.example`) for local dev.

```bash
npx wrangler secret put VERIFY_CLIENT_ID
npx wrangler secret put VERIFY_CLIENT_SECRET
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put WORKER_BASE_URL
npx wrangler secret put CF_ACCESS_CLIENT_ID
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
```

| Secret | Value / Notes |
|--------|--------------|
| `VERIFY_CLIENT_ID` | `363515bd-3987-444f-84c4-b0e023b09763` — MCP Server Subject app |
| `VERIFY_CLIENT_SECRET` | Subject app secret from IBM Verify Admin Console |
| `SLACK_SIGNING_SECRET` | AskIAM Slack app → Basic Information → Signing Secret |
| `GEMINI_API_KEY` | Google AI Studio — https://aistudio.google.com/apikey |
| `WORKER_BASE_URL` | `https://askiam-bot.baronia.workers.dev` |
| `CF_ACCESS_CLIENT_ID` | Cloudflare Access service token ID (see below) |
| `CF_ACCESS_CLIENT_SECRET` | Cloudflare Access service token secret (see below) |
| KV `ASKIAM_TOKENS` | Namespace binding — stores OAuth tokens per Slack `user_id` |

---

## Cloudflare Setup

The MCP server at `mcp.baronia.work` sits behind a Cloudflare geo-block firewall rule
(blocks EU, NA, AF, SA). Cloudflare Workers egress from global PoPs that hit this rule.
Two things are needed to allow the Worker through.

### 1 — Cloudflare Access service token

Creates a machine-to-machine credential the Worker sends on every request so Cloudflare
Access lets it bypass the geo-block rule.

1. **Zero Trust → Access → Service Auth → Service Tokens → Create Service Token**
   - Name: `askiam-worker`
   - Copy the `CF-Access-Client-Id` and `CF-Access-Client-Secret` (shown once)
2. **Zero Trust → Access → Applications → Add → Self-hosted**
   - Domain: `mcp.baronia.work`
   - Policy action: **Service Auth** → select the token above
   - Save
3. Set the copied values as Worker secrets (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`)

The Worker sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers on every MCP
request. Cloudflare validates them before the request reaches the tunnel.

### 2 — WAF custom rule skip (geo-block bypass)

The geo-block rule fires before Cloudflare Access evaluates service tokens, so a WAF skip
rule is also needed. Add this in:

**Cloudflare Dashboard → `baronia.work` → Security → WAF → Custom Rules → Create rule**

| Field | Value |
|-------|-------|
| Rule name | `Skip geo-block for AskIAM Worker` |
| Expression | `http.request.headers["cf-access-client-id"][0] eq "43d9da893619275a3947ed8ddb299338.access"` |
| Action | **Skip** → All remaining custom rules |
| Position | Above the "Block Access Outside of Asia" rule |

---

## IBM Verify Setup

### Redirect URI

Add this redirect URI to the **MCP Server Subject** app (`363515bd`) in the IBM Verify
Admin Console → Applications → edit → Redirect URIs:

```
https://askiam-bot.baronia.workers.dev/oauth/callback
```

### Entitlements

Every Slack user who runs `/askiam` must be entitled to the **MCP Server Subject** app:

Admin Console → Applications → Applications → **MCP Server Subject** → Entitlements tab → add user

---

## Slack App Setup

1. **https://api.slack.com/apps** → **Create New App** → **From an app manifest**
2. Use the **JSON** tab — paste [`slack-app-manifest.json`](slack-app-manifest.json)
3. Install to workspace → copy **Signing Secret** → push as `SLACK_SIGNING_SECRET`
4. Slash command request URL: `https://askiam-bot.baronia.workers.dev/slack/command`

---

## MCP Protocol Notes

The IBM Verify MCP server uses the **MCP Streamable HTTP** transport (spec `2024-11-05`).
Every session requires:

1. **`initialize`** — POST to `/mcp` with no `mcp-session-id`. Server returns a
   `mcp-session-id` response header. Requires a valid IBM Verify Bearer token.
2. **`tools/call`** — POST to `/mcp` with the `mcp-session-id` from step 1.

Required headers on every MCP request:

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer <ibm_verify_access_token>` |
| `Content-Type` | `application/json` |
| `Accept` | `application/json, text/event-stream` |
| `persona` | `admin` (exposes all 34 IBM Verify tools) |
| `mcp-session-id` | Session ID from `initialize` (omit on the `initialize` call itself) |
| `CF-Access-Client-Id` | Cloudflare service token ID |
| `CF-Access-Client-Secret` | Cloudflare service token secret |

Responses may be `application/json` or `text/event-stream` (SSE). The client handles both.

---

## Example Queries

**User management (admin)**
```
/askiam how many users do we have
/askiam list users in the Engineering department
/askiam show profile for john@acme.com
/askiam create a user jane.smith@acme.com, Jane Smith, in Finance
/askiam reset password for john@acme.com
```

**Group management (admin)**
```
/askiam list all groups
/askiam find groups with Admin in the name
/askiam add sarah@acme.com to the Finance Approvers group
/askiam how many groups are there
```

**Application management (admin)**
```
/askiam list all applications
/askiam show the config for the Salesforce app
/askiam what application types can I create
```

**MFA management (admin)**
```
/askiam show MFA enrollments for john@acme.com
/askiam list all MFA enrollments in the tenant
/askiam which MFA methods are enabled in the tenant
```

**Access requests (self-service)**
```
/askiam what apps can I request access to
/askiam what roles are available for Salesforce
/askiam request Sales Rep access to Salesforce for the Q3 project
/askiam show my pending access requests
/askiam has my Salesforce request been approved yet
/askiam remind the approver on my Jira request
/askiam cancel my Confluence access request
/askiam show pending approvals
/askiam approve Tony Stark's Salesforce request
/askiam what access do I currently have
```

**My MFA (self-service)**
```
/askiam show my MFA enrollments
/askiam delete my TOTP enrollment
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

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Unexpected token '<'` | MCP server returned HTML error page instead of JSON | Already fixed — `!resp.ok` guard added |
| `MCP server error 403` | Geo-block firewall rule firing | Add WAF skip rule (see Cloudflare Setup above) |
| `406 Not Acceptable` | Missing `Accept` header on MCP request | Already fixed — header added |
| `400 Missing session ID` | `tools/call` sent without first calling `initialize` | Already fixed — session handshake added |
| Tool unavailable (Gemini fallback) | `persona: admin` header missing | Already fixed — header added |
| `redirect_uri_mismatch` on login | Redirect URI not registered | Add `https://askiam-bot.baronia.workers.dev/oauth/callback` to Subject app |
| `Authentication session expired` on callback | PKCE state TTL is 5 min | Run `/askiam` again and click promptly |
| `401 Unauthorized` from MCP server | User not entitled to Subject app | Admin Console → MCP Server Subject → Entitlements → add user |
| Token keeps expiring | Refresh token revoked | Click the auth link once to renew |
| Gemini routing fails silently | Bad or missing API key | Check `GEMINI_API_KEY`; try `/askiam count all users` |
