# VerifyBot — IBM Verify SaaS → Slack Alerts & Reports

**A complete step-by-step cookbook for building an automated IBM Verify security monitoring bot that posts real-time alerts, daily digests, and interactive on-demand reports to a Slack channel — powered by a Cloudflare Worker and Google Gemini AI.**

---

## What You Will Build

```
IBM Verify SaaS
  (audit events)
        │  poll (Events API, every minute)
        ▼
  Cloudflare Worker  (worker-verifybot)
        │
        │  classify with Gemini AI
        │  score severity 0–10
        │
        ▼
  Slack #ibm-verify-alerts
    • Real-time alert cards (severity ≥ 6)
    • Daily digest at 08:00 SGT
    • Weekly / monthly / quarterly reports
    • /report — interactive report picker with drill-down buttons
```

**Capabilities:**

| Feature | What it does |
|---------|-------------|
| Real-time alerts | Events API polled every minute → Gemini scores severity → posts alert card if score ≥ 6 |
| Daily digest | 08:00 SGT summary: KPI scorecard, Identity Lens (Human vs NHI), category bars, AI narrative |
| Weekly / monthly / quarterly | Scheduled period reports with trend analysis |
| Drill-down buttons | Each report section has a button that posts a full subcategory breakdown |
| `/report` command | Post the report picker or trigger a specific window directly |
| Colour coding | Category dots (🟢🔵🟡🟠🔴) + Health dot + Human 👤 / NHI 🤖 identity classification |

---

## Prerequisites — What You Need Before Starting

| Requirement | Where to get it |
|-------------|----------------|
| IBM Verify SaaS tenant | Your IBM account — tenant URL is e.g. `acme.verify.ibm.com` |
| Cloudflare account (free tier is fine) | https://cloudflare.com |
| Google AI Studio account | https://aistudio.google.com |
| Slack workspace (admin access needed) | https://slack.com |
| Node.js ≥ 18 installed on your laptop | https://nodejs.org |
| A terminal (macOS Terminal, Windows WSL, or Linux shell) | Built into your OS |
| Git installed | https://git-scm.com |

---

## Overview of Steps

1. [Clone the repository](#step-1--clone-the-repository)
2. [Create the Slack App and channel](#step-2--create-the-slack-app-and-channel)
3. [Get a Google Gemini API key](#step-3--get-a-google-gemini-api-key)
4. [Create the IBM Verify Events API client](#step-4--create-the-ibm-verify-events-api-client)
5. [Set up the Cloudflare Worker](#step-5--set-up-the-cloudflare-worker)
6. [Deploy and configure secrets](#step-6--deploy-and-configure-secrets)
7. [Test everything end-to-end](#step-7--test-everything-end-to-end)

---

## Step 1 — Clone the Repository

Open a terminal on your laptop:

```bash
git clone https://github.com/rkbenton/verify-slack-bots.git
cd verify-slack-bots/worker-verifybot
```

The `worker-verifybot/` directory contains:

```
worker-verifybot/
├── index.js                  Main Worker — all routes and cron handlers
├── wrangler.toml             Cloudflare config — cron schedules, KV binding
├── slack-app-manifest.yaml   Slack app manifest (used in Step 2)
├── .dev.vars.example         Secret template — copy to .dev.vars for local dev
├── package.json
└── shared/
    ├── gemini.js             Gemini AI — event classification, narratives
    ├── slack.js              Slack Block Kit builders — alerts, digests, reports
    ├── mcp-client.js         IBM Verify token helper (client_credentials)
    └── verify-events.js      IBM Verify Events API client (pagination)
```

---

## Step 2 — Create the Slack App and Channel

### 2.1 Create the alert channel

1. In your Slack workspace, click **+ Add a channel**
2. Name it `ibm-verify-alerts` (or any name you like)
3. Set it to **Private** or **Public** — your choice
4. Note the channel name — you will need it in Step 2.3

### 2.2 Create the Slack App

1. Go to https://api.slack.com/apps
2. Click **Create New App**
3. Choose **From an app manifest**
4. Select your workspace, click **Next**
5. Switch to the **YAML** tab and paste the contents of [`slack-app-manifest.yaml`](slack-app-manifest.yaml) from this folder

   > **Note:** The manifest contains placeholder URLs like `https://verify-bot.baronia.workers.dev`. You can use the file as-is for now — you'll update the real Worker URL after deploying in Step 5. Slack won't validate the URLs at creation time.

6. Click **Next**, review, click **Create**

### 2.3 Install the app and get the Incoming Webhook URL

1. In your new app's settings, go to **OAuth & Permissions** in the left sidebar
2. Click **Install to Workspace**, then **Allow**
3. In the left sidebar, go to **Incoming Webhooks**
4. Toggle **Activate Incoming Webhooks** to ON
5. Click **Add New Webhook to Workspace**
6. Select your `#ibm-verify-alerts` channel, click **Allow**
7. Copy the Webhook URL — it looks like:
   `https://hooks.slack.com/services/TXXXXXXXX/BXXXXXXXX/XXXXXXXXXXXXXXXX`
8. **Save this** — it becomes `SLACK_ALERT_WEBHOOK_URL` in Step 6

### 2.4 Get the Signing Secret

1. In the left sidebar, click **Basic Information**
2. Scroll down to **App Credentials**
3. Copy the **Signing Secret**
4. **Save this** — it becomes `SLACK_SIGNING_SECRET` in Step 6

### 2.5 Enable Interactivity (required for drill-down report buttons)

> **Important:** This step cannot be done via the manifest — you must do it manually after deploying the Worker so you have a real URL.

1. In the left sidebar, click **Interactivity & Shortcuts**
2. Toggle **Interactivity** to **ON**
3. Set the **Request URL** to `https://YOUR-WORKER-HOSTNAME/slack/actions`
   (you'll get the Worker hostname in Step 5 — come back and do this then)
4. Click **Save Changes**

---

## Step 3 — Get a Google Gemini API Key

The Worker uses Gemini to classify event severity, write AI narratives for reports, and route `/report` queries.

1. Go to https://aistudio.google.com
2. Sign in with your Google account
3. Click **Get API key** in the top-left corner
4. Click **Create API key**
5. Select **Create API key in new project** (or choose an existing project)
6. Copy the key — it looks like `AIzaSy...`
7. **Save this** — it becomes `GEMINI_API_KEY` in Step 6

> **Cost:** The `gemini-2.0-flash-lite` model used here has a generous free tier. For a typical IBM Verify tenant processing a few thousand events per day, you will stay well within the free quota.

---

## Step 4 — Create the IBM Verify Events API Client

The Worker needs an API client credential to authenticate with the IBM Verify Events API.

1. Log in to your IBM Verify admin console: `https://YOUR-TENANT.verify.ibm.com`
2. Go to **Security → API Access** in the left sidebar
   (On some versions it may be under **Applications → API clients**)
3. Click **Add API client**
4. Fill in:
   - **Name:** `VerifyBot Events`
   - **Description:** `Cloudflare Worker — audit event polling and reports`
5. Under **Entitlements**, enable both:
   - ✅ **Manage reports**
   - ✅ **Read reports**
6. Click **Save**
7. Copy the **Client ID** and **Client Secret** that are shown
8. **Save these** — they become `EVENTS_CLIENT_ID` and `EVENTS_CLIENT_SECRET` in Step 6

> **Important:** Copy the Client Secret immediately after saving — IBM Verify only shows it once.

---

## Step 5 — Set Up the Cloudflare Worker

### 5.1 Install Wrangler (Cloudflare's CLI)

Open a terminal:

```bash
npm install -g wrangler
```

Verify it installed:

```bash
wrangler --version
# Should print: wrangler X.X.X
```

Log in to Cloudflare (this opens your browser):

```bash
wrangler login
```

### 5.2 Create the KV namespace

The Worker uses Cloudflare KV (a key-value store) to track the poll cursor and cache report data for drill-down buttons.

From the `worker-verifybot/` directory:

```bash
cd worker-verifybot
wrangler kv namespace create VERIFY_BOT_STATE
```

The output will look like:

```
Add the following to your configuration file in your kv_namespaces list:
{ binding = "VERIFY_BOT_STATE", id = "abc123def456..." }
```

Copy the `id` value. Open `wrangler.toml` and paste it into the `id` field:

```toml
[[kv_namespaces]]
binding = "VERIFY_BOT_STATE"
id = "abc123def456..."       # ← paste your id here
```

### 5.3 Review `wrangler.toml`

Open `wrangler.toml`. It should look like this (you only need to confirm the KV `id` from the previous step is set):

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
id = "YOUR-KV-ID"              # ← must be filled in from Step 5.2
```

> **Timezone note:** Cloudflare cron is always UTC. SGT = UTC+8, so `0 0 * * *` (midnight UTC) = 08:00 SGT.

### 5.4 Install dependencies and deploy

```bash
cd worker-verifybot   # if you're not already here
npm install
wrangler deploy
```

The output will end with something like:

```
Deployed verify-bot triggers
  https://verify-bot.YOUR-ACCOUNT.workers.dev
  schedule: * * * * *
  schedule: 0 0 * * *
  ...
```

**Copy your Worker URL** — e.g. `https://verify-bot.YOUR-ACCOUNT.workers.dev`.

Now go back to **Step 2.5** and paste this URL into the Slack Interactivity Request URL field:
`https://verify-bot.YOUR-ACCOUNT.workers.dev/slack/actions`

---

## Step 6 — Deploy and Configure Secrets

Never put secrets in code or `wrangler.toml`. Cloudflare Worker Secrets are encrypted at rest and only accessible inside your Worker at runtime.

Run each command from the `worker-verifybot/` directory and paste the value when prompted:

```bash
# IBM Verify Events API client (from Step 4)
wrangler secret put EVENTS_CLIENT_ID
wrangler secret put EVENTS_CLIENT_SECRET

# Google Gemini API key (from Step 3)
wrangler secret put GEMINI_API_KEY

# Slack Incoming Webhook URL (from Step 2.3)
wrangler secret put SLACK_ALERT_WEBHOOK_URL

# Slack Signing Secret (from Step 2.4)
wrangler secret put SLACK_SIGNING_SECRET

# Severity threshold — events scoring at or above this fire a real-time alert (0-10 scale)
# 6 is a good default: catches failed logins, admin changes, MFA removal
wrangler secret put SEVERITY_THRESHOLD
# When prompted, type: 6
```

Verify all secrets are set:

```bash
wrangler secret list
```

You should see all 6 secrets listed (names only — values are never shown).

### Summary of all secrets

| Secret | Description | Where you got it |
|--------|-------------|-----------------|
| `EVENTS_CLIENT_ID` | IBM Verify API client ID for Events API | Step 4 |
| `EVENTS_CLIENT_SECRET` | IBM Verify API client secret for Events API | Step 4 |
| `GEMINI_API_KEY` | Google AI Studio API key | Step 3 |
| `SLACK_ALERT_WEBHOOK_URL` | Slack Incoming Webhook URL | Step 2.3 |
| `SLACK_SIGNING_SECRET` | Slack app signing secret | Step 2.4 |
| `SEVERITY_THRESHOLD` | Min severity score to fire a real-time alert (0–10) | Set to `6` |

---

## Step 7 — Test Everything End-to-End

### 7.1 Test the health endpoint

```bash
curl https://verify-bot.YOUR-ACCOUNT.workers.dev/health
# Expected: {"status":"ok","worker":"verify-bot"}
```

If you get an error, check that the Worker deployed successfully in Step 5.4.

### 7.2 Trigger a manual daily digest

This is the fastest way to verify the whole pipeline (Cloudflare → IBM Verify Events API → Gemini → Slack) works end-to-end.

```bash
curl -X POST "https://verify-bot.YOUR-ACCOUNT.workers.dev/trigger-summary" \
  -H "X-Trigger-Secret: YOUR-SLACK-SIGNING-SECRET"
```

Replace `YOUR-SLACK-SIGNING-SECRET` with the value you set as `SLACK_SIGNING_SECRET`.

Expected response:
```json
{"status":"ok","message":"daily summary triggered"}
```

Check your `#ibm-verify-alerts` channel — within 30 seconds you should see the daily digest card appear.

### 7.3 Trigger a 7-day report

```bash
curl -X POST "https://verify-bot.YOUR-ACCOUNT.workers.dev/trigger-summary?days=7" \
  -H "X-Trigger-Secret: YOUR-SLACK-SIGNING-SECRET"
```

### 7.4 Test the /report slash command in Slack

In any Slack channel where the bot is installed:

```
/report
```

You should see three buttons: **Last 7 Days**, **Last 30 Days**, **Last 90 Days**.

Click **Last 7 Days** — you should see:
1. An ephemeral message: *"Generating 7-day report…"*
2. After 10–30 seconds, the full report card appears in `#ibm-verify-alerts`

Each section of the report has a drill-down button:
- **Breakdown** — Identity Lens with Human vs NHI subcategories
- **All categories** — full category list with coloured dots
- **All actions** — all event actions grouped by category
- **All users** — complete active identity list, Human and NHI separated

> If buttons show a ⚠️ warning triangle, Interactivity is not enabled — go back to Step 2.5.

### 7.5 Verify the 1-minute poll is running

Watch live Worker logs:

```bash
wrangler tail --format=pretty
```

Wait up to 1 minute — you should see lines like:

```
[POLL] fetched 3 events since 2026-10-07T...
[POLL SKIP] issued severity=1
[POLL SKIP] issued severity=2
[POLL SKIP] login severity=3
```

This confirms the cron is running and the Events API is being polled successfully.

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
│  1. 👤 alice — 62      │  1. 🤖 [svc] 25c4af96… — 154      │
│  2. 👤 bob — 60        │  2. 🤖 [svc] ...                   │
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

The threshold controls which events fire a real-time alert card. Update the secret:

```bash
wrangler secret put SEVERITY_THRESHOLD
# Recommended values:
# 5 = more alerts (medium-severity and above)
# 6 = default (high and above, plus auth failures floor at 7)
# 8 = quiet mode (only critical events)
```

No redeployment needed — secrets take effect immediately.

### Change the cron schedule / timezone

Cloudflare cron is always UTC. To change the daily digest time, edit `wrangler.toml`:

```toml
# Examples for different timezones:
# SGT (UTC+8): "0 0 * * *"  = midnight UTC = 08:00 SGT
# EST (UTC-5): "0 13 * * *" = 13:00 UTC = 08:00 EST
# GMT (UTC+0): "0 8 * * *"  = 08:00 UTC = 08:00 GMT

[triggers]
crons = ["* * * * *", "0 0 * * *", "0 0 * * 1", "0 0 1 * *", "0 0 1 */3 *"]
```

After editing `wrangler.toml`, redeploy to apply the new schedule:

```bash
wrangler deploy
```

### Change the Gemini model

Edit the first line of `shared/gemini.js`:

```js
const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent';
```

Available models: `gemini-2.0-flash-lite` (fast, free tier), `gemini-2.0-flash` (better quality, slightly slower).

---

## Troubleshooting

### No messages appearing in Slack

1. Check the Worker is deployed: `curl https://verify-bot.YOUR-ACCOUNT.workers.dev/health`
2. Check secrets are all set: `wrangler secret list`
3. Test the Slack webhook URL directly:
   ```bash
   curl -X POST YOUR-WEBHOOK-URL -d '{"text":"test from curl"}'
   # Expected: ok
   ```
4. Trigger a report manually and watch logs:
   ```bash
   wrangler tail --format=pretty &
   curl -X POST "https://verify-bot.YOUR-ACCOUNT.workers.dev/trigger-summary" \
     -H "X-Trigger-Secret: YOUR-SLACK-SIGNING-SECRET"
   ```

### AI narrative is missing / shows a short fallback

```bash
wrangler tail --format=pretty
```

Look for `[Gemini]` error lines. Common causes:

| Error | Fix |
|-------|-----|
| `401 Invalid API key` | Regenerate key at https://aistudio.google.com |
| `404 Model not found` | Update the model name in `shared/gemini.js` |
| `429 Quota exceeded` | Check your Google AI Studio usage dashboard |

### Buttons show a ⚠️ warning triangle

The Slack app's Interactivity is disabled or pointed at the wrong URL. Go to:
**api.slack.com → Your App → Interactivity & Shortcuts → ON → set Request URL to `https://YOUR-WORKER/slack/actions` → Save**

### "Detail data has expired" when clicking drill-down

The KV cache TTL has expired (24 hours for daily reports, 7 days for period reports). Run `/report` again and regenerate the report — the buttons on the fresh card will work.

### Events API returns 403

Your API client is missing the required entitlements. In IBM Verify admin console:

1. Go to **Security → API Access**
2. Find the `VerifyBot Events` client from Step 4
3. Add ✅ **Manage reports** and ✅ **Read reports** entitlements
4. Save — no Worker restart needed

### Cron not firing

```bash
wrangler deploy   # re-registers cron triggers
wrangler triggers list   # verify they are shown
```

---

## Cloudflare KV — Inspecting Poll State

Your KV namespace (`VERIFY_BOT_STATE`) stores:

| Key pattern | Contents | TTL |
|-------------|----------|-----|
| `lastPolledTime` | ISO timestamp of the last Events API poll | No expiry |
| `report_stats__daily_*` | Aggregated stats for daily report drill-down | 24 hours |
| `report_stats__period7_*` | Stats for 7-day report drill-down | 7 days |
| `report_stats__period30_*` | Stats for 30-day report drill-down | 7 days |
| `report_stats__period90_*` | Stats for 90-day report drill-down | 7 days |

Inspect KV from the terminal:

```bash
# List all keys
wrangler kv key list --binding=VERIFY_BOT_STATE

# Read the current poll cursor
wrangler kv key get --binding=VERIFY_BOT_STATE "lastPolledTime"
```

Or browse it visually in the Cloudflare Dashboard → **Workers & Pages → KV → verify-bot-VERIFY_BOT_STATE → KV Pairs**.

---

## Useful Commands Reference

```bash
# Install dependencies
npm install

# Deploy (or redeploy after changes)
wrangler deploy

# Watch live logs
wrangler tail --format=pretty

# Trigger a manual report
curl -X POST "https://YOUR-WORKER.workers.dev/trigger-summary" \
  -H "X-Trigger-Secret: YOUR-SLACK-SIGNING-SECRET"

# Trigger a period report (valid values: 7, 30, 90)
curl -X POST "https://YOUR-WORKER.workers.dev/trigger-summary?days=7" \
  -H "X-Trigger-Secret: YOUR-SLACK-SIGNING-SECRET"

# Add or update a secret
wrangler secret put SECRET_NAME

# List all secrets (names only)
wrangler secret list

# List KV keys
wrangler kv key list --binding=VERIFY_BOT_STATE

# Read a specific KV value
wrangler kv key get --binding=VERIFY_BOT_STATE "lastPolledTime"
```

---

## Files Reference

| File | Purpose |
|------|---------|
| `index.js` | Main Worker — HTTP routes, cron dispatch, `handleScheduled()`, `handleDailySummary()`, `handlePeriodSummary()` |
| `wrangler.toml` | Cloudflare Worker config — name, cron schedules, KV binding |
| `slack-app-manifest.yaml` | Slack app manifest — use in Step 2.2 |
| `shared/gemini.js` | All Gemini AI calls — `classifyEvent()`, `generateDailySummary()`, `generatePeriodInsights()`, `generateSectionCommentary()` |
| `shared/slack.js` | All Slack Block Kit builders — alert card, daily digest, period report, drill-down payloads |
| `shared/verify-events.js` | IBM Verify Events API client with automatic pagination |
| `shared/mcp-client.js` | IBM Verify token helper (`client_credentials` grant) |

---

*Built with Cloudflare Workers · Google Gemini · IBM Verify SaaS · Slack Block Kit*
