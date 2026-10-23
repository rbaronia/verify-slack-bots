# verify-slack-bots

Two Cloudflare Workers that connect **IBM Verify SaaS** to Slack.

| Worker | Folder | Purpose |
|--------|--------|---------|
| **VerifyBot** | [`worker-verifybot/`](worker-verifybot/) | Real-time event alerts, AI-classified, plus scheduled digest reports and an on-demand `/report` command |
| **AskIAM** | [`worker-askiam/`](worker-askiam/) | `/askiam` slash command — natural-language IAM queries via IBM Verify MCP server |

---

## 📖 Cookbooks — Start Here

If you're setting this up for the first time, follow the step-by-step cookbooks:

- **[VerifyBot Cookbook](worker-verifybot/COOKBOOK.md)** — set up real-time alerts, daily digests, and scheduled reports in Slack
- **[AskIAM Cookbook](worker-askiam/COOKBOOK.md)** — set up the `/askiam` natural-language query command in Slack

Both cookbooks assume no prior knowledge of Cloudflare Workers or IBM Verify APIs.

---

## Why Two Workers?

The IBM Verify MCP server (`mcp.baronia.work`) only accepts **user** Bearer tokens obtained
through an OAuth Authorization Code flow — it rejects headless `client_credentials` tokens.

- **VerifyBot** runs fully headless (cron poll every minute) using `client_credentials` for the
  Events API — it can never call the MCP server.
- **AskIAM** does a real auth-code + PKCE flow per Slack user, caches tokens in KV, and
  calls the MCP server on their behalf.

---

## Quick Start (for developers already familiar with the setup)

```bash
# VerifyBot — events, alerts, reports
cd worker-verifybot
npm install && npx wrangler deploy

# AskIAM — /askiam slash command
cd worker-askiam
npm install && npx wrangler deploy
```

See each folder's `COOKBOOK.md` for the full setup walkthrough including secrets, IBM Verify
app configuration, and Slack app manifest.

---

## Architecture Overview

```
IBM Verify SaaS (YOUR-TENANT.verify.ibm.com)
  │
  ├── Events API ──────────────────────────► worker-verifybot
  │     (cron poll every minute)                 │
  │                                              ├── Gemini classify (severity 0–10)
  │                                              ├── Slack alerts (#ibm-verify-alerts)
  │                                              └── /report digests (1/7/30/90 day)
  │
  └── OAuth / MCP ──────────────────────────► worker-askiam
        (auth-code + PKCE per Slack user)         │
                                                  ├── /askiam slash command
                                                  ├── KV token cache (per Slack user_id)
                                                  └── mcp.baronia.work → IBM Verify APIs
```

---

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com) with Workers + KV enabled (free tier is fine)
- [IBM Verify SaaS tenant](https://www.ibm.com/products/verify-identity) with:
  - An API client for the Events API (needs Manage + Read reports entitlements)
  - An OIDC Subject application (auth-code + PKCE) for AskIAM
- [Slack workspace](https://slack.com) with permission to create apps
- [Google AI Studio](https://aistudio.google.com) API key (Gemini 2.0 Flash Lite)
- Node.js 18+ and `npx` available locally

---

## Repo Structure

```
verify-slack-bots/
├── README.md                  This file
├── worker-verifybot/          VerifyBot — events + reports Worker
│   ├── index.js
│   ├── wrangler.toml
│   ├── slack-app-manifest.yaml
│   ├── .dev.vars.example
│   ├── COOKBOOK.md            ← step-by-step setup guide
│   ├── README.md              ← technical reference
│   ├── package.json
│   └── shared/
│       ├── gemini.js
│       ├── slack.js
│       ├── mcp-client.js
│       └── verify-events.js
└── worker-askiam/             AskIAM — /askiam slash command Worker
    ├── index.js
    ├── wrangler.toml
    ├── slack-app-manifest.yaml
    ├── slack-app-manifest.json
    ├── .dev.vars.example
    ├── COOKBOOK.md            ← step-by-step setup guide
    ├── README.md              ← technical reference
    ├── package.json
    └── shared/
        ├── gemini.js
        └── mcp-client.js
```

---

## Cloudflare KV Usage

Both workers use Workers KV on the **free tier** (1,000 puts/day limit).

| Namespace | Worker | What it stores |
|-----------|--------|---------------|
| `VERIFY_BOT_STATE` | verifybot | `lastPolledTime` cursor + report stats for drill-down buttons |
| `ASKIAM_TOKENS` | askiam | OAuth tokens per Slack user, PKCE state, paginated result cache |

Put operations are minimised by design:
- `verifybot` writes `lastPolledTime` at most every 5 minutes (not every cron tick)
- `askiam` caches paginated results under a **shared key** (not per-user), so 10 users querying the same data costs 1 put, not 10
- Results are only cached when they exceed 25 rows (the pagination threshold)

If you exceed the free-tier limit, inspect your namespaces:
```bash
npx wrangler kv key list --namespace-id=YOUR-KV-ID
```
Or browse them at **Cloudflare Dashboard → Workers & Pages → KV**.
