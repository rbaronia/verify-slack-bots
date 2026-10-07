# VerifyBot — IBM Verify SaaS → Slack Alerts & Reports

**A complete step-by-step cookbook for building an automated IBM Verify security monitoring bot that posts real-time alerts, daily digests, and interactive on-demand reports to a Slack channel — powered by a Cloudflare Worker and Google Gemini AI.**

---

## What You Will Build

```
IBM Verify SaaS ──────────────────────────────────────────────────────────┐
  (audit events)                                                           │
        │  push (webhook)          pull (Events API, every minute)         │
        ▼                          ▼                                       │
  Cloudflare Worker  ──────────────────────────────────────────────────   │
    verify-bot                                                             │
        │                                                                  │
        │  classify with Gemini AI                                         │
        │  score severity 0–10                                             │
        │                                                                  │
        ▼                                                                  │
  Slack #ibm-verify-alerts ─────────────────────────────────────────────  │
    • Real-time alert cards (severity ≥ 6)                                 │
    • Daily digest at 08:00 SGT                                            │
    • Weekly / monthly / quarterly reports                                 │
    • /report — interactive report picker with drill-down buttons          │
    • /askiam — natural language IAM queries (e.g. "list locked users")    │
```

**Capabilities:**

| Feature | What it does |
|---------|-------------|
| Real-time alerts | Webhook push from IBM Verify → Gemini scores severity → posts alert card if score ≥ 6 |
| 1-minute poll | Fallback poll of Events API catches any missed webhook events |
| Daily digest | 08:00 SGT summary: KPI scorecard, Identity Lens (Human vs NHI), category bars, AI narrative |
| Weekly / monthly / quarterly | Scheduled period reports with trend analysis |
| Drill-down buttons | Each report section has a button that posts a full subcategory breakdown (ephemeral, only visible to you) |
| `/report` command | Post the report picker or trigger a specific window directly |
| `/askiam` command | Ask natural-language IAM questions answered by querying the IBM Verify MCP server |
| Colour coding | Category dots (🟢🔵🟡🟠🔴) + Health dot + Human 👤 / NHI 🤖 identity classification |

---

## Prerequisites — What You Need Before Starting

| Requirement | Where to get it |
|-------------|----------------|
| IBM Verify SaaS tenant | Your IBM account — tenant name is e.g. `acme` → `acme.verify.ibm.com` |
| Cloudflare account (free tier is fine) | https://cloudflare.com |
| Google AI Studio account | https://aistudio.google.com |
| Slack workspace (admin access needed) | https://slack.com |
| Node.js ≥ 18 installed on your laptop | https://nodejs.org |
| A terminal (macOS Terminal, Windows WSL, or Linux shell) | Built into your OS |

---

## Overview of Steps

1. [Create the Slack App and channel](#step-1--create-the-slack-app-and-channel)
2. [Get a Google Gemini API key](#step-2--get-a-google-gemini-api-key)
3. [Create IBM Verify API clients](#step-3--create-ibm-verify-api-clients)
4. [Set up the Cloudflare Worker](#step-4--set-up-the-cloudflare-worker)
5. [Deploy and configure secrets](#step-5--deploy-and-configure-secrets)
6. [Configure IBM Verify webhook push](#step-6--configure-ibm-verify-webhook-push)
7. [Test everything end-to-end](#step-7--test-everything-end-to-end)

---

## Step 1 — Create the Slack App and Channel

### 1.1 Create the alert channel

1. In your Slack workspace, click **+ Add a channel**
2. Name it `ibm-verify-alerts` (or any name you like)
3. Set it to **Private** or **Public** — your choice
4. Note the channel name — you will need it in Step 1.3

### 1.2 Create the Slack App

1. Go to https://api.slack.com/apps
2. Click **Create New App**
3. Choose **From an app manifest**
4. Select your workspace, click **Next**
5. Paste the following YAML manifest (replace `YOUR-WORKER-HOSTNAME` with your Cloudflare Worker URL — you will get this in Step 4, but you can update it later):

```yaml
display_information:
  name: VerifyBot
  description: IBM Verify IAM alerts + self-service queries
  background_color: "#0530AD"
features:
  bot_user:
    display_name: VerifyBot
    always_online: true
  slash_commands:
    - command: /askiam
      url: https://YOUR-WORKER-HOSTNAME/slack/command
      description: Ask IBM Verify — list users, groups, MFA status and more
      usage_hint: "e.g. how many users are locked out?"
      should_escape: false
    - command: /report
      url: https://YOUR-WORKER-HOSTNAME/slack/command
      description: Pull an IBM Verify activity report (7 / 30 / 90 days)
      usage_hint: "7 | 30 | 90"
      should_escape: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.public
      - commands
      - app_mentions:read
      - incoming-webhook
settings:
  event_subscriptions:
    request_url: https://YOUR-WORKER-HOSTNAME/slack/events
    bot_events:
      - app_mention
  interactivity:
    is_enabled: true
    request_url: https://YOUR-WORKER-HOSTNAME/slack/actions
  socket_mode_enabled: false
```

6. Click **Next**, review, click **Create**

### 1.3 Install the app and get the Incoming Webhook URL

1. In your new app's settings, go to **OAuth & Permissions** in the left sidebar
2. Click **Install to Workspace**, then **Allow**
3. In the left sidebar, go to **Incoming Webhooks**
4. Toggle **Activate Incoming Webhooks** to ON
5. Click **Add New Webhook to Workspace**
6. Select your `#ibm-verify-alerts` channel, click **Allow**
7. Copy the Webhook URL — it looks like:
   `https://hooks.slack.com/services/TXXXXXXXX/BXXXXXXXX/XXXXXXXXXXXXXXXX`
8. Save this — it becomes `SLACK_ALERT_WEBHOOK_URL` in Step 5

### 1.4 Get the Signing Secret

1. In the left sidebar, click **Basic Information**
2. Scroll down to **App Credentials**
3. Copy the **Signing Secret**
4. Save this — it becomes `SLACK_SIGNING_SECRET` in Step 5

### 1.5 Enable Interactivity (required for drill-down buttons)

> **Important:** This step cannot be done via the manifest — you must do it manually.

1. In the left sidebar, click **Interactivity & Shortcuts**
2. Toggle **Interactivity** to **ON**
3. Set the **Request URL** to `https://YOUR-WORKER-HOSTNAME/slack/actions`
4. Click **Save Changes**

---

## Step 2 — Get a Google Gemini API Key

The Worker uses Gemini to classify event severity, write AI narratives, and answer `/askiam` queries.

1. Go to https://aistudio.google.com
2. Sign in with your Google account
3. Click **Get API key** in the top left
4. Click **Create API key**
5. Select **Create API key in new project** (or choose an existing project)
6. Copy the key — it looks like `AIzaSy...`
7. Save this — it becomes `GEMINI_API_KEY` in Step 5

> **Cost:** The `gemini-3.5-flash-lite` model used here is free up to generous quotas. For a typical IBM Verify tenant with a few thousand events per day, you will stay well within the free tier.

---

## Step 3 — Create IBM Verify API Clients

You need **two** API clients in IBM Verify SaaS:

| Client | Purpose | Required entitlements |
|--------|---------|----------------------|
| **Events client** | Fetch audit events for reports and polling | Manage reports, Read reports |
| **Webhook client** | (Optional) validate incoming webhook signatures | None — webhook uses a shared secret you generate |

### 3.1 Create the Events API client

1. Log in to your IBM Verify admin console: `https://YOUR-TENANT.verify.ibm.com`
2. Go to **Security → API Access** (or **Applications → API clients** depending on your version)
3. Click **Add API client**
4. Fill in:
   - **Name:** `VerifyBot Events`
   - **Description:** Cloudflare Worker — audit event polling and reports
5. Under **Entitlements**, enable:
   - **Manage reports**
   - **Read reports**
6. Click **Save**
7. Copy the **Client ID** and **Client Secret**
8. Save these — they become `EVENTS_CLIENT_ID` and `EVENTS_CLIENT_SECRET` in Step 5

### 3.2 Configure the Notification Webhook (push events)

IBM Verify can push events to your Worker in real time — this is faster than polling.

1. In the IBM Verify admin console, go to **Security → Notifications** (or search for "Webhook")
2. Click **Add notification subscription** or **Add webhook**
3. Fill in:
   - **URL:** `https://YOUR-WORKER-HOSTNAME/verify-webhook`
   - **Events to send:** Select all, or at minimum: Authentication, Management, SSO, Token, Risk
4. Under **Security**, choose **Custom header** and set:
   - **Header name:** `X-Verify-Secret`
   - **Header value:** Generate a long random string — e.g. run this in your terminal:
     ```bash
     openssl rand -hex 32
     ```
     Example output: `347fb3a7535bf822cb54f84be3b4d5f8d70cd0e377130558f714b9cfaca36d3b`
5. Click **Save**
6. Copy the secret value — it becomes `VERIFY_WEBHOOK_SECRET` in Step 5

> **Note:** If your IBM Verify version doesn't have webhook push, the Worker's 1-minute poll will handle everything without it.

---

## Step 4 — Set Up the Cloudflare Worker

### 4.1 Install Wrangler (Cloudflare's CLI)

Open a terminal on your laptop:

```bash
npm install -g wrangler
```

Verify it installed:

```bash
wrangler --version
# Should print: wrangler X.X.X
```

Log in to Cloudflare:

```bash
wrangler login
# Opens your browser — log in to your Cloudflare account
```

### 4.2 Get the Worker code

Clone or download the repository containing the Worker:

```bash
git clone https://github.com/YOUR-USERNAME/YOUR-REPO.git
cd YOUR-REPO/workers
```

The `workers/` directory contains:

```
workers/
├── index.js                  Main Worker — all routes and cron handlers
├── wrangler.toml             Cloudflare config — cron schedules, KV binding
├── slack-app-manifest.yaml   Slack app manifest (used in Step 1)
├── package.json
└── shared/
    ├── gemini.js             Gemini AI — event classification, narratives, /askiam routing
    ├── slack.js              Slack Block Kit builders — alerts, digests, reports, drill-downs
    ├── mcp-client.js         IBM Verify MCP server client (/askiam queries)
    └── verify-events.js      IBM Verify Events API client with pagination
```

### 4.3 Create the KV namespace

The Worker uses Cloudflare KV (a key-value store) to track poll state and cache report data for drill-down buttons.

```bash
# Create the namespace
wrangler kv namespace create VERIFY_BOT_STATE
```

The output will look like:
```
Add the following to your configuration file in your kv_namespaces list:
{ binding = "VERIFY_BOT_STATE", id = "abc123def456..." }
```

Copy the `id` value and open `wrangler.toml`. Update the `id` field:

```toml
[[kv_namespaces]]
binding = "VERIFY_BOT_STATE"
id = "abc123def456..."       # ← paste your id here
```

### 4.4 Review `wrangler.toml`

Open `wrangler.toml` and check/update the `name` if you want a custom subdomain:

```toml
name = "verify-bot"            # your Worker will be at verify-bot.YOUR-ACCOUNT.workers.dev
main = "index.js"
compatibility_date = "2024-09-01"

[triggers]
crons = [
  "* * * * *",     # every minute — poll Events API
  "0 0 * * *",     # 08:00 SGT daily digest
  "0 0 * * 1",     # 08:00 SGT Monday weekly report
  "0 0 1 * *",     # 08:00 SGT 1st of month report
  "0 0 1 */3 *"    # 08:00 SGT quarterly report
]

[[kv_namespaces]]
binding = "VERIFY_BOT_STATE"
id = "YOUR-KV-ID"
```

> **Timezone note:** Cloudflare cron uses UTC. SGT = UTC+8, so `0 0 * * *` (UTC midnight) = 08:00 SGT.

### 4.5 Deploy the Worker

```bash
cd workers
npm install
wrangler deploy
```

The output will end with something like:
```
Deployed verify-bot triggers
  https://verify-bot.YOUR-ACCOUNT.workers.dev
```

**Copy your Worker URL** — you need it in Step 1.2 (update the Slack manifest) and Step 3.2 (IBM Verify webhook).

---

## Step 5 — Deploy and Configure Secrets

Never put secrets in code or `wrangler.toml`. Cloudflare Worker Secrets are encrypted at rest and only accessible inside your Worker.

Run each command and paste the value when prompted:

```bash
# The shared secret you generated in Step 3.2 (webhook validation)
wrangler secret put VERIFY_WEBHOOK_SECRET

# IBM Verify Events API client (from Step 3.1)
wrangler secret put EVENTS_CLIENT_ID
wrangler secret put EVENTS_CLIENT_SECRET

# Google Gemini API key (from Step 2)
wrangler secret put GEMINI_API_KEY

# Slack Incoming Webhook URL (from Step 1.3)
wrangler secret put SLACK_ALERT_WEBHOOK_URL

# Slack Signing Secret (from Step 1.4)
wrangler secret put SLACK_SIGNING_SECRET

# Severity threshold — events scoring at or above this fire an alert (0-10 scale)
# 6 is a good default: catches failed logins, admin changes, MFA removal
wrangler secret put SEVERITY_THRESHOLD
# Enter: 6
```

Verify all secrets are set:

```bash
wrangler secret list
```

You should see all 7 secrets listed.

### Summary of all secrets

| Secret name | Description | Where you got it |
|-------------|-------------|-----------------|
| `VERIFY_WEBHOOK_SECRET` | Shared secret for IBM Verify webhook validation | Generated in Step 3.2 |
| `EVENTS_CLIENT_ID` | IBM Verify API client ID for Events API | Step 3.1 |
| `EVENTS_CLIENT_SECRET` | IBM Verify API client secret for Events API | Step 3.1 |
| `GEMINI_API_KEY` | Google AI Studio API key | Step 2 |
| `SLACK_ALERT_WEBHOOK_URL` | Slack Incoming Webhook URL | Step 1.3 |
| `SLACK_SIGNING_SECRET` | Slack app signing secret | Step 1.4 |
| `SEVERITY_THRESHOLD` | Minimum score to fire a real-time alert (0–10) | Set to `6` |

---

## Step 6 — Configure IBM Verify Webhook Push

Return to your IBM Verify admin console and finish configuring the webhook notification you started in Step 3.2.

### 6.1 Update the webhook URL

Now that you have your Worker URL from Step 4.5, update the webhook destination:

1. Go to **Security → Notifications** in IBM Verify admin console
2. Find the webhook you created in Step 3.2
3. Update the **URL** to: `https://YOUR-WORKER-HOSTNAME.workers.dev/verify-webhook`
4. Save

### 6.2 Verify the webhook is active

IBM Verify may send a test event when you save. Check your `#ibm-verify-alerts` channel — if the test event scores above 6, you'll see a card. If not, check the Worker logs:

```bash
wrangler tail
```

Look for lines like:
```
[SKIP] severity=2 user.authentication.login
[ALERT] user.authentication.failed severity=7
```

---

## Step 7 — Test Everything End-to-End

### 7.1 Test the health endpoint

```bash
curl https://YOUR-WORKER-HOSTNAME.workers.dev/health
# Expected: {"status":"ok","worker":"verify-bot"}
```

### 7.2 Trigger a manual daily digest

```bash
curl -X POST "https://YOUR-WORKER-HOSTNAME.workers.dev/trigger-summary?days=1" \
  -H "X-Verify-Secret: YOUR-WEBHOOK-SECRET"
```

Expected response:
```json
{"status":"ok","message":"1-day summary posted to Slack","days":1}
```

Check your `#ibm-verify-alerts` channel — you should see the daily digest.

### 7.3 Trigger a 7-day report

```bash
curl -X POST "https://YOUR-WORKER-HOSTNAME.workers.dev/trigger-summary?days=7" \
  -H "X-Verify-Secret: YOUR-WEBHOOK-SECRET"
```

### 7.4 Test the /report slash command in Slack

In any Slack channel:
```
/report
```

You should see three buttons: **Last 7 Days**, **Last 30 Days**, **Last 90 Days**.

Click **Last 7 Days** — you should see:
1. An ephemeral message: *"Generating 7-day report — it will appear in the channel shortly."*
2. After ~10–30 seconds, the full report card appears in `#ibm-verify-alerts`

Each section of the report has a drill-down button:
- **Breakdown** — opens Identity Lens with Human vs NHI subcategories
- **All categories** — full category list with coloured dots
- **All actions** — all event actions grouped by category
- **All users** — complete active identity list, Human and NHI separated

### 7.5 Test the /askiam command

```
/askiam count all users
/askiam list users in Engineering group
/askiam show MFA enrollments for dfox@example.com
/askiam how many groups are there
```

VerifyBot will query IBM Verify in real time and post the answer in the channel.

### 7.6 Verify the 1-minute poll is running

```bash
wrangler tail
```

Wait up to 1 minute — you should see:
```
"* * * * *" — Ok
  (log) [POLL] fetched 3 events since 2026-10-07T...
  (log) [POLL SKIP] issued severity=1
  (log) [POLL SKIP] issued severity=2
  (log) [POLL SKIP] login severity=3
```

This confirms the cron is running and the Events API is being polled.

---

## Understanding the Report Layout

Every report follows this structure:

```
┌─────────────────────────────────────────────────────────────┐
│  HEADER: IBM Verify · Last 7 Days · 30 Sept – 7 Oct 2026   │
├─────────────────────────────────────────────────────────────┤
│  AI NARRATIVE (blockquote)                                   │
│  "Over the last 7 days, IBM Verify recorded 1,362 events..." │
├─────────────────────────────────────────────────────────────┤
│  KPI SCORECARD (6 fields)                                    │
│  🟢 Health · 0 failures  │  Total Events  1,362             │
│  Failures  56  (4.1%)    │  Alerts Fired  3                 │
│  Avg / Day  195          │  Success Rate  96%               │
├─────────────────────────────────────────────────────────────┤
│  IDENTITY LENS                               [Breakdown]     │
│  👤 Human  ████░░░░░░  377  (28%)                           │
│  🤖 NHI    ██████████  985  (72%)                           │
├─────────────────────────────────────────────────────────────┤
│  ACTIVITY BY CATEGORY                  [All categories]      │
│  🔵 Token          ██████████  985  (72%)                   │
│  🟡 Management     ██░░░░░░░░  201  (15%)                   │
│  🟢 Authentication  █░░░░░░░░  164  (12%)                   │
│  + 1 more categories                                         │
├─────────────────────────────────────────────────────────────┤
│  TOP EVENT ACTIONS                         [All actions]     │
│  1. 🔵 🤖 Token Issued — 961                                │
│  2. 🟡 👤 Modified — 86                                     │
│  3. 🔵 🤖 Token Introspect — 86                             │
│  + 3 more actions                                            │
├─────────────────────────────────────────────────────────────┤
│  MOST ACTIVE USERS                          [All users]      │
│  Human Identities      │  Service Accounts (NHI)            │
│  1. 👤 palice — 62     │  1. 🤖 [svc] 25c4af96… — 154      │
│  2. 👤 ptom — 60       │  2. 🤖 [svc] ...                   │
├─────────────────────────────────────────────────────────────┤
│  [Last 7 Days]  [Last 30 Days]  [Last 90 Days]              │
└─────────────────────────────────────────────────────────────┘
```

### Identity classification

| Label | Meaning | Examples |
|-------|---------|---------|
| 👤 **Human** | Interactive user sessions | Login, SSO, MFA enrolment, password reset, access requests |
| 🤖 **NHI** (Non-Human Identity) | Automated / machine interactions | Token issued/revoked/introspected, SCIM provisioning, API grants |

### Category colour scheme

| Dot | Category | Typical events |
|-----|----------|---------------|
| 🟢 | Authentication | Login success/failure, OIDC, MFA challenge |
| 🔵 | Token | OAuth token issued, revoked, introspected |
| 🟣 | SSO | SAML assertions, federated login |
| 🟠 | MFA | Enrolment, factor activation/removal |
| 🟡 | Management | User/group create, modify, delete |
| 🔶 | Provisioning | SCIM sync, directory provisioning |
| 🔷 | Access Request | Access request submitted/approved/rejected |
| 🔴 | Password | Password reset, credential change |
| ⚪ | Directory | Reports, consent, directory operations |
| ⬜ | Uncategorised | Everything else |

### Health indicator

| Dot | Label | Condition |
|-----|-------|-----------|
| 🟢 | Healthy | 0 failures |
| 🟡 | Warning | 1–4 failures (daily) / 1–9 failures (period) |
| 🟠 | Elevated | 5–19 failures (daily) / 10–49 failures (period) |
| 🔴 | Critical | 20+ failures (daily) / 50+ failures (period) |

---

## Customisation Reference

### Change the severity threshold

The threshold controls which events fire a real-time alert card (vs just being included in the digest). Update the secret:

```bash
wrangler secret put SEVERITY_THRESHOLD
# Enter a number 0-10. Recommended values:
# 5 = more alerts (medium + above)
# 6 = default (high + above, plus auth failures)
# 8 = quiet (only critical events)
```

### Change the cron schedule timezone

Cloudflare cron is always UTC. To change the daily digest time, edit `wrangler.toml`:

```toml
# Examples for different timezones:
# SGT (UTC+8): "0 0 * * *"  = midnight UTC = 08:00 SGT
# EST (UTC-5): "0 13 * * *" = 13:00 UTC = 08:00 EST
# GMT (UTC+0): "0 8 * * *"  = 08:00 UTC = 08:00 GMT

[triggers]
crons = ["* * * * *", "0 0 * * *", "0 0 * * 1", "0 0 1 * *", "0 0 1 */3 *"]
```

After editing, redeploy:
```bash
wrangler deploy
```

### Add more event types to poll

Edit `workers/shared/verify-events.js`, line 55:

```js
// Add any of: "service", "fulfillment", "adaptive_risk", "cert_campaign",
//             "access_request", "account_sync", "privacy_consent"
const EVENT_TYPES = '"management","authentication","sso","adaptive_risk","access_request","token"';
```

### Add more category keywords

Edit the `bucketByCategory` function in `workers/shared/slack.js` to classify new action types into existing or new categories.

### Change the Gemini model

Edit the first line of `workers/shared/gemini.js`:

```js
const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';
```

Available models (as of 2026): `gemini-3.5-flash-lite` (fast, free tier), `gemini-3.5-flash` (better quality).

---

## Troubleshooting

### No messages appearing in Slack

1. Check the Worker is deployed: `curl https://YOUR-WORKER.workers.dev/health`
2. Check secrets are set: `wrangler secret list`
3. Check Slack webhook URL is correct: try `curl -X POST YOUR-WEBHOOK-URL -d '{"text":"test"}'`
4. Trigger a test manually: `curl -X POST "https://YOUR-WORKER.workers.dev/trigger-summary?days=1" -H "X-Verify-Secret: YOUR-SECRET"`

### AI narrative is missing / shows short fallback

```bash
wrangler tail
```

Look for `[Gemini daily narrative]` error lines. Common causes:
- **Invalid API key** → regenerate at https://aistudio.google.com
- **Model not found (404)** → update the model name in `gemini.js`
- **Quota exceeded** → check your Google AI Studio usage dashboard

### Buttons show warning triangle

The Slack app's Interactivity is disabled. Go to:
**api.slack.com → Your App → Interactivity & Shortcuts → ON → set Request URL → Save**

### "Detail data has expired" when clicking drill-down

The KV cache TTL has expired. The drill-down cache is 24 hours for daily reports and 7 days for period reports. Regenerate the report to refresh it.

### Events API returns 403

Your API client is missing the required entitlements. In IBM Verify admin console:
1. Go to the API client created in Step 3.1
2. Add **Manage reports** and **Read reports** entitlements
3. Save — no Worker restart needed

### Worker CPU limit exceeded

The free Cloudflare Workers tier has a 10ms CPU limit per request. The paid tier (Workers Unbound, ~$5/month) has no CPU limit and is recommended for large tenants with millions of events. To check usage: Cloudflare Dashboard → Workers → Your Worker → Metrics.

---

## Architecture Notes

### Why a Cloudflare Worker?

Cloudflare Workers run at the edge — in every Cloudflare data centre globally. They have:
- **No cold starts** — instant response to Slack interactions (Slack requires < 3s)
- **Built-in cron** — no separate scheduler needed
- **KV storage** — lightweight state for poll cursors and drill-down cache
- **Free tier** — 100,000 requests/day, 1,000 cron invocations/day

### Why poll AND receive webhooks?

Webhooks can be missed if your Worker has a momentary issue or IBM Verify retries fail. The 1-minute poll is a safety net that catches any events the webhook missed. Events already seen via webhook are not double-counted in reports because the poll uses a time window (`lastPolledTime` cursor in KV).

### Why Gemini for classification?

IBM Verify events don't have a severity field — they just record what happened. Gemini reads the action type, result, username, and application name and makes a contextual judgment (e.g. "admin deleted a user" vs "user logged in successfully"). Deterministic overrides (`applyMinimums()` in `gemini.js`) ensure critical event types always score high enough to alert, regardless of what Gemini returns.

### Data privacy

No user data is stored permanently. The KV store only holds:
- `lastPolledTime` — an ISO timestamp (no user data)
- `report_stats__*` — aggregated counts per action type and top user IDs (expires in 24h–7d)

Individual event details are processed in-memory and never persisted.

---

## Files Reference

| File | Purpose |
|------|---------|
| `index.js` | Main Worker entry point — HTTP routes, cron dispatch, `buildStats()`, `bucketCategoriesForGemini()` |
| `wrangler.toml` | Cloudflare Worker config — name, cron schedules, KV binding |
| `slack-app-manifest.yaml` | Slack app manifest — use in Step 1.2 |
| `shared/gemini.js` | All Gemini AI calls — `classifyEvent()`, `generateDailySummary()`, `generatePeriodInsights()`, `generateSectionCommentary()`, `routeQuery()`, `answerQuery()` |
| `shared/slack.js` | All Slack Block Kit builders — alert card, daily digest, period report, drill-down payloads, `buildReportControlPanel()` |
| `shared/verify-events.js` | IBM Verify Events API client with automatic pagination |
| `shared/mcp-client.js` | IBM Verify MCP server client for `/askiam` queries |

---

## Useful Commands Reference

```bash
# Deploy the Worker
wrangler deploy

# Watch live logs (tail)
wrangler tail --format=pretty

# Trigger a manual report (replace SECRET and DAYS)
curl -X POST "https://YOUR-WORKER.workers.dev/trigger-summary?days=1" \
  -H "X-Verify-Secret: YOUR-SECRET"

# Valid values for days: 1, 7, 30, 90

# Add or update a secret
wrangler secret put SECRET_NAME

# List all secrets
wrangler secret list

# List KV keys (useful for debugging poll state)
wrangler kv key list --binding=VERIFY_BOT_STATE

# Read a specific KV value
wrangler kv key get --binding=VERIFY_BOT_STATE "lastPolledTime"

# Delete stale drill-down cache manually
wrangler kv key list --binding=VERIFY_BOT_STATE | \
  grep "report_stats" | \
  awk '{print $1}' | \
  xargs -I {} wrangler kv key delete --binding=VERIFY_BOT_STATE {}
```

---

*Built with Cloudflare Workers · Google Gemini · IBM Verify SaaS · Slack Block Kit*
