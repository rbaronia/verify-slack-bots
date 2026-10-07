# verify-slack-bots

Two Cloudflare Workers that connect **IBM Verify SaaS** to Slack.

| Worker | Folder | Purpose |
|--------|--------|---------|
| **VerifyBot** | [`worker-verifybot/`](worker-verifybot/) | Real-time event alerts, AI-classified, plus scheduled `/report` digests |
| **AskIAM** | [`worker-askiam/`](worker-askiam/) | `/askiam` slash command — natural-language IAM queries via IBM Verify MCP server |

---

## Why Two Workers?

The IBM Verify MCP server (`mcp.baronia.work`) only accepts **user** Bearer tokens obtained
through an OAuth Authorization Code flow — it rejects headless `client_credentials` tokens.

- **VerifyBot** runs fully headless (cron + webhooks) using `client_credentials` for the
  Events API — it can never call the MCP server.
- **AskIAM** does a real auth-code + PKCE flow per Slack user, caches tokens in KV, and
  calls the MCP server on their behalf.

---

## Quick Start

```bash
# VerifyBot — events, alerts, reports
cd worker-verifybot
npm install && npx wrangler deploy

# AskIAM — /askiam slash command
cd worker-askiam
npm install && npx wrangler deploy
```

See each folder's `README.md` for the full secret setup and Slack app configuration.

---

## Architecture Overview

```
IBM Verify SaaS (baronia.verify.ibm.com)
  │
  ├── Events API ──────────────────────────► worker-verifybot
  │     (cron poll + push webhook)               │
  │                                              ├── Gemini classify
  │                                              ├── Slack alerts (#ibm-verify-alerts)
  │                                              └── /report digests (7/30/90 day)
  │
  └── OAuth / MCP ──────────────────────────► worker-askiam
        (auth-code + PKCE per Slack user)         │
                                                  ├── /askiam slash command
                                                  ├── KV token cache (per Slack user_id)
                                                  └── mcp.baronia.work → IBM Verify APIs
```

---

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com) with Workers + KV enabled
- [IBM Verify SaaS tenant](https://www.ibm.com/products/verify-identity) with:
  - An API client for Events (needs Manage + Read reports entitlements)
  - An OAuth Subject application (auth-code + PKCE) for AskIAM
- [Slack workspace](https://slack.com) with permission to create apps
- [Google AI Studio](https://aistudio.google.com) API key (Gemini 3.5 Flash Lite)
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
    ├── package.json
    └── shared/
        ├── gemini.js
        └── mcp-client.js
```
