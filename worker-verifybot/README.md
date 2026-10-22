# worker-verifybot — IBM Verify Events Bot

A Cloudflare Worker that polls the IBM Verify SaaS audit Events API every minute and posts
AI-classified security alerts to Slack, plus scheduled digest reports and an on-demand
`/report` slash command.

**Live Worker:** `https://verify-bot.baronia.workers.dev`  
**Slack channel:** `#ibm-verify-alerts`  
**Tenant:** `baronia.verify.ibm.com`

---

## Architecture

```
IBM Verify SaaS
  └── Events API (cron poll every minute)  →  handleScheduled()
                                                  │
                                                  ├── Gemini classify (severity 0–10)
                                                  └── Slack Block Kit alert → #ibm-verify-alerts

Slack
  ├── /report [days]  →  POST /slack/command  →  button panel or instant report
  └── Button clicks   →  POST /slack/actions  →  period summary → Slack webhook

Cron (Cloudflare)
  ├── * * * * *      →  every minute: poll Events API, fire real-time alerts
  ├── 0 0 * * *      →  08:00 SGT daily digest
  ├── 0 0 * * 1      →  08:00 SGT Monday — 7-day weekly report
  ├── 0 0 1 * *      →  08:00 SGT 1st of month — 30-day report
  └── 0 0 1 */3 *    →  08:00 SGT quarterly — 90-day report
```

---

## File Map

```
worker-verifybot/
├── index.js                   Main Worker — HTTP routes + cron dispatch
├── wrangler.toml              Worker name, KV binding, 5 cron triggers
├── slack-app-manifest.yaml    Slack app definition — paste into api.slack.com
├── .dev.vars.example          Secret template — copy to .dev.vars for local dev
├── package.json               wrangler@4
└── shared/
    ├── gemini.js              Gemini 3.5 Flash Lite — classify, summarise, insights
    ├── slack.js               Block Kit builders + webhook/response_url transport
    ├── mcp-client.js          IBM Verify token helper (client_credentials)
    └── verify-events.js       IBM Verify Events API client (pagination, epoch ms)
```

---

## Deploy

```bash
cd worker-verifybot
npm install          # first time only
npx wrangler deploy  # deploys + registers all 5 crons
```

---

## Secrets

```bash
cd worker-verifybot
npx wrangler secret put EVENTS_CLIENT_ID
npx wrangler secret put EVENTS_CLIENT_SECRET
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_ALERT_WEBHOOK_URL
npx wrangler secret put SEVERITY_THRESHOLD   # e.g. 6
```

| Secret | Purpose |
|--------|---------|
| `EVENTS_CLIENT_ID` | IBM Verify API client for the Events API (needs Manage + Read reports entitlements) |
| `EVENTS_CLIENT_SECRET` | Secret for the Events API client |
| `GEMINI_API_KEY` | Gemini 3.5 Flash Lite — event classification + report narratives |
| `SLACK_SIGNING_SECRET` | HMAC verification for all Slack requests |
| `SLACK_ALERT_WEBHOOK_URL` | Incoming webhook URL — posts alerts and reports |
| `SEVERITY_THRESHOLD` | Min severity (0–10) to fire a real-time alert (default: 6) |
| KV `VERIFY_BOT_STATE` | Stores `lastPolledTime` for cron event polling |

---

## Slack App Setup

1. **https://api.slack.com/apps** → **Create New App** → **From an app manifest**
2. Paste [`slack-app-manifest.yaml`](slack-app-manifest.yaml) (use JSON tab if YAML errors)
3. Install to workspace → copy **Signing Secret** → push as `SLACK_SIGNING_SECRET`
4. Copy **Incoming Webhook URL** → push as `SLACK_ALERT_WEBHOOK_URL`
5. Left sidebar → **Interactivity & Shortcuts** → toggle **ON** → Request URL:  
   `https://verify-bot.baronia.workers.dev/slack/actions`

---

## Cron Schedule (SGT = UTC+8)

| Cron | SGT time | What fires |
|------|----------|-----------|
| `* * * * *` | every minute | Poll Events API — real-time alert detection |
| `0 0 * * *` | 08:00 daily | 24-hour digest |
| `0 0 * * 1` | 08:00 Monday | 7-day weekly report |
| `0 0 1 * *` | 08:00 1st of month | 30-day monthly report |
| `0 0 1 */3 *` | 08:00 Jan/Apr/Jul/Oct | 90-day quarterly report |

---

## Severity Floor (deterministic post-Gemini)

| Condition | Minimum severity |
|-----------|-----------------|
| Auth failure | 7 |
| MFA removal / deactivation | 8 |
| Password reset / account delete | 8 |
| Impersonation / escalation | 9 |

---

## Test On-Demand

Manually trigger a summary with `curl` — protected by `X-Trigger-Secret: <SLACK_SIGNING_SECRET>`:

```bash
SECRET=<SLACK_SIGNING_SECRET>

curl -X POST https://verify-bot.baronia.workers.dev/trigger-summary \
  -H "X-Trigger-Secret: $SECRET"                   # daily digest

curl -X POST "https://verify-bot.baronia.workers.dev/trigger-summary?days=7" \
  -H "X-Trigger-Secret: $SECRET"                   # 7-day

curl -X POST "https://verify-bot.baronia.workers.dev/trigger-summary?days=30" \
  -H "X-Trigger-Secret: $SECRET"                   # 30-day

curl -X POST "https://verify-bot.baronia.workers.dev/trigger-summary?days=90" \
  -H "X-Trigger-Secret: $SECRET"                   # 90-day
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Button warning triangle | Enable Interactivity in Slack app settings (see setup step 5) |
| Events API 403 | `EVENTS_CLIENT_ID` client needs Manage+Read reports entitlements |
| No alerts firing | Lower `SEVERITY_THRESHOLD`; auth failures floor at 7 |
| `getToken is not defined` | Re-deploy — stale Worker version cached at Cloudflare edge |
| Cron not firing | `npx wrangler deploy` re-registers; verify with `npx wrangler triggers list` |
| Slack webhook 400 | Block too long — `npx wrangler tail` to inspect Block Kit error |
