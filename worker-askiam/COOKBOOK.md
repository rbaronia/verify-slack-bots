# AskIAM — Natural-Language IBM Verify Queries in Slack

**A complete step-by-step cookbook for building a Slack bot that lets you ask plain-English questions about your IBM Verify tenant — "how many users are locked out?", "show pending access requests", "reset password for john@acme.com" — answered in real time from Slack.**

---

## What You Will Build

```
User in Slack
  │
  │  /askiam how many users do we have
  ▼
Cloudflare Worker  (worker-askiam)
  │
  ├─ Has a token for this user?
  │
  ├── YES → Gemini picks the right IBM Verify API call
  │              └── Calls IBM Verify MCP server on the user's behalf
  │                      └── Gemini formats the answer → posted back to Slack
  │
  └── NO → Send a "sign in with IBM Verify" link
            User authenticates → token stored → original query runs automatically
```

**What you can ask:**

| Category | Example queries |
|----------|----------------|
| Users | `/askiam how many users do we have` · `/askiam show profile for john@acme.com` |
| Groups | `/askiam list all groups` · `/askiam find groups with Admin in the name` |
| Applications | `/askiam list all applications` · `/askiam show config for Salesforce` |
| MFA | `/askiam show MFA enrollments for john@acme.com` · `/askiam which MFA methods are enabled` |
| Access requests | `/askiam show my pending access requests` · `/askiam approve Tony's Salesforce request` |
| Self-service | `/askiam show my MFA enrollments` · `/askiam what apps can I request access to` |
| Write operations | `/askiam reset password for john@acme.com` *(admin only, requires confirmation click)* |

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

> **Why do users need to sign in?** The IBM Verify MCP server requires a real user's token — it rejects the headless machine tokens used by most API clients. This means every Slack user authenticates with their own IBM Verify identity. Their token is stored in Cloudflare KV (encrypted) and auto-refreshed, so they only need to sign in once.

---

## Overview of Steps

1. [Clone the repository](#step-1--clone-the-repository)
2. [Create the Slack App](#step-2--create-the-slack-app)
3. [Get a Google Gemini API key](#step-3--get-a-google-gemini-api-key)
4. [Create the IBM Verify OAuth application](#step-4--create-the-ibm-verify-oauth-application)
5. [Set up Cloudflare Access for the MCP server](#step-5--set-up-cloudflare-access-for-the-mcp-server)
6. [Set up the Cloudflare Worker](#step-6--set-up-the-cloudflare-worker)
7. [Deploy and configure secrets](#step-7--deploy-and-configure-secrets)
8. [Entitle users to run /askiam](#step-8--entitle-users-to-run-askiam)
9. [Test everything end-to-end](#step-9--test-everything-end-to-end)

---

## Step 1 — Clone the Repository

Open a terminal on your laptop:

```bash
git clone https://github.com/rkbenton/verify-slack-bots.git
cd verify-slack-bots/worker-askiam
```

The `worker-askiam/` directory contains:

```
worker-askiam/
├── index.js                    Main Worker — /slack/command, /oauth/callback, /health
├── wrangler.toml               Worker name, KV binding (ASKIAM_TOKENS)
├── slack-app-manifest.yaml     Slack app manifest (YAML)
├── slack-app-manifest.json     Same manifest in JSON (use if Slack rejects YAML)
├── .dev.vars.example           Secret template — copy to .dev.vars for local dev
├── package.json
└── shared/
    ├── gemini.js               routeQuery() + answerQuery() — Gemini 2.0 Flash Lite
    └── mcp-client.js           callTool() — calls the IBM Verify MCP server
```

---

## Step 2 — Create the Slack App

### 2.1 Create the Slack App from the manifest

1. Go to https://api.slack.com/apps
2. Click **Create New App**
3. Choose **From an app manifest**
4. Select your workspace, click **Next**
5. Try the **YAML** tab first — paste the contents of [`slack-app-manifest.yaml`](slack-app-manifest.yaml) from this folder
   - If Slack shows an error, switch to the **JSON** tab and paste [`slack-app-manifest.json`](slack-app-manifest.json) instead

   > **Note:** The manifest contains placeholder URLs like `https://askiam-bot.baronia.workers.dev`. You can leave them for now — you'll update them after deploying in Step 6.

6. Click **Next**, review, click **Create**

### 2.2 Install the app to your workspace

1. In the left sidebar, click **OAuth & Permissions**
2. Click **Install to Workspace**, then **Allow**

### 2.3 Get the Signing Secret

1. In the left sidebar, click **Basic Information**
2. Scroll down to **App Credentials**
3. Copy the **Signing Secret**
4. **Save this** — it becomes `SLACK_SIGNING_SECRET` in Step 7

### 2.4 Update the slash command URL (after Step 6)

After deploying the Worker in Step 6, you'll need to come back and update the slash command URL:

1. In the left sidebar, click **Slash Commands**
2. Click the pencil icon next to `/askiam`
3. Update the **Request URL** to: `https://YOUR-WORKER.workers.dev/slack/command`
4. Click **Save**

---

## Step 3 — Get a Google Gemini API Key

AskIAM uses Gemini to understand your question (e.g. "how many users are locked out?") and decide which IBM Verify API to call, then to format the answer into a readable Slack message.

1. Go to https://aistudio.google.com
2. Sign in with your Google account
3. Click **Get API key** in the top-left corner
4. Click **Create API key**
5. Select **Create API key in new project** (or choose an existing project)
6. Copy the key — it looks like `AIzaSy...`
7. **Save this** — it becomes `GEMINI_API_KEY` in Step 7

> **Cost:** The `gemini-2.0-flash-lite` model used here has a generous free tier. Normal `/askiam` usage (a few queries per user per day) will stay well within free quota.

---

## Step 4 — Create the IBM Verify OAuth Application

AskIAM needs an **OIDC application** in IBM Verify that uses the Authorization Code + PKCE flow. This is what generates the "sign in with IBM Verify" link that users click the first time they use `/askiam`.

### 4.1 Create the application

1. Log in to your IBM Verify admin console: `https://YOUR-TENANT.verify.ibm.com`
2. Go to **Applications → Applications** in the left sidebar
3. Click **Add application**
4. Select **Custom application** → **Add application**
5. On the **General** tab:
   - **Application name:** `AskIAM Slack Bot`
   - **Company name:** your company name
6. Click the **Sign-on** tab (it may be labelled **Single sign-on** depending on your version)
7. Set **Sign-on method** to **Open ID Connect 1.0**
8. Set **Application URL** to your future Worker URL: `https://askiam-bot.YOUR-ACCOUNT.workers.dev`
   (you can update this after Step 6 — it doesn't block setup)
9. Under **Grant types**, ensure **Authorization code** is checked ✅
10. Under **PKCE**, ensure it is **supported or required** ✅
11. Under **Redirect URIs**, click **Add** and enter:
    ```
    https://askiam-bot.YOUR-ACCOUNT.workers.dev/oauth/callback
    ```
    (Update `YOUR-ACCOUNT` to match your Cloudflare subdomain — you'll confirm this in Step 6)
12. Click **Save**

### 4.2 Copy the client credentials

After saving, IBM Verify shows the **Client ID** and **Client Secret**:

1. Copy the **Client ID** (a UUID like `363515bd-3987-444f-84c4-b0e023b09763`)
2. Copy the **Client Secret**
3. **Save both** — they become `VERIFY_CLIENT_ID` and `VERIFY_CLIENT_SECRET` in Step 7

> **Important:** Copy the Client Secret immediately — IBM Verify only shows it once.

---

## Step 5 — Set Up Cloudflare Access for the MCP Server

The IBM Verify MCP server (`mcp.baronia.work`) sits behind Cloudflare's security layer. Your Worker needs a Cloudflare **service token** to be allowed through.

> **Why is this needed?** The MCP server uses Cloudflare Access to restrict who can connect. A service token is a machine-to-machine credential — your Worker sends it as a request header and Cloudflare lets it through.

### 5.1 Create a Service Token

1. Go to the [Cloudflare Zero Trust dashboard](https://one.cloudflare.com)
2. In the left sidebar, go to **Access → Service Auth → Service Tokens**
3. Click **Create Service Token**
4. Set **Service Token Name** to: `askiam-worker`
5. Click **Generate token**
6. **Copy both values immediately** — they are only shown once:
   - `CF-Access-Client-Id` (ends in `.access`)
   - `CF-Access-Client-Secret`
7. **Save these** — they become `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in Step 7

### 5.2 Create an Access Application for the MCP server

1. In Cloudflare Zero Trust, go to **Access → Applications**
2. Click **Add an application**
3. Choose **Self-hosted**
4. Fill in:
   - **Application name:** `IBM Verify MCP Server`
   - **Application domain:** `mcp.baronia.work`
5. Click **Next**
6. Under **Policy name**, enter: `Allow AskIAM Worker`
7. Under **Action**, select **Service Auth**
8. Under **Include**, select **Service Token** → choose `askiam-worker`
9. Click **Next**, then **Add application**

### 5.3 Add a WAF skip rule (if a geo-block rule is in place)

If `mcp.baronia.work` has a WAF rule that blocks traffic by geography, you need a skip rule so your Worker's service token bypasses it.

1. Go to the Cloudflare Dashboard → the zone for `baronia.work` → **Security → WAF → Custom Rules**
2. Click **Create rule**
3. Fill in:
   - **Rule name:** `Skip geo-block for AskIAM Worker`
   - **Expression:** 
     ```
     http.request.headers["cf-access-client-id"][0] eq "YOUR-CF-ACCESS-CLIENT-ID"
     ```
     (replace with your actual client ID from Step 5.1)
   - **Action:** **Skip** → All remaining custom rules
4. **Position:** drag this rule to appear **above** any geo-block rule
5. Click **Deploy**

> **Skip this step** if there is no geo-block rule on `mcp.baronia.work`.

---

## Step 6 — Set Up the Cloudflare Worker

### 6.1 Install Wrangler (Cloudflare's CLI)

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

### 6.2 Create the KV namespace

The Worker stores OAuth tokens in Cloudflare KV so users only need to sign in once.

From the `worker-askiam/` directory:

```bash
cd worker-askiam
wrangler kv namespace create ASKIAM_TOKENS
```

The output will look like:

```
Add the following to your configuration file in your kv_namespaces list:
{ binding = "ASKIAM_TOKENS", id = "abc123def456..." }
```

Copy the `id` value. Open `wrangler.toml` and paste it into the `id` field:

```toml
[[kv_namespaces]]
binding = "ASKIAM_TOKENS"
id = "abc123def456..."       # ← paste your id here
```

### 6.3 Review `wrangler.toml`

Open `wrangler.toml`. It should look like this:

```toml
name = "askiam-bot"            # your Worker will be at askiam-bot.YOUR-ACCOUNT.workers.dev
main = "index.js"
compatibility_date = "2024-01-01"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "ASKIAM_TOKENS"
id = "YOUR-KV-ID"              # ← must be filled in from Step 6.2
```

> **Your Worker URL** will be `https://askiam-bot.YOUR-ACCOUNT.workers.dev`. You need this URL for:
> - The OAuth redirect URI you set in Step 4.1
> - The Slack slash command URL you'll update in Step 2.4

### 6.4 Install dependencies and deploy

```bash
cd worker-askiam   # if you're not already here
npm install
wrangler deploy
```

The output will end with:

```
Deployed askiam-bot
  https://askiam-bot.YOUR-ACCOUNT.workers.dev
```

**Copy your Worker URL.**

Now go back and:
- **Step 2.4** — update the Slack slash command URL to `https://askiam-bot.YOUR-ACCOUNT.workers.dev/slack/command`
- **Step 4.1** — confirm the redirect URI in IBM Verify matches `https://askiam-bot.YOUR-ACCOUNT.workers.dev/oauth/callback`

---

## Step 7 — Deploy and Configure Secrets

Never put secrets in code or `wrangler.toml`. Cloudflare Worker Secrets are encrypted at rest and only accessible inside your Worker at runtime.

Run each command from the `worker-askiam/` directory. You will be prompted to paste the value:

```bash
# IBM Verify OAuth app client ID and secret (from Step 4.2)
wrangler secret put VERIFY_CLIENT_ID
wrangler secret put VERIFY_CLIENT_SECRET

# Slack Signing Secret (from Step 2.3)
wrangler secret put SLACK_SIGNING_SECRET

# Google Gemini API key (from Step 3)
wrangler secret put GEMINI_API_KEY

# Your Worker's public URL — used to build the OAuth callback URL
wrangler secret put WORKER_BASE_URL
# When prompted, enter: https://askiam-bot.YOUR-ACCOUNT.workers.dev

# Cloudflare Access service token (from Step 5.1)
wrangler secret put CF_ACCESS_CLIENT_ID
wrangler secret put CF_ACCESS_CLIENT_SECRET
```

Verify all secrets are set:

```bash
wrangler secret list
```

You should see all 7 secrets listed (names only — values are never shown).

### Summary of all secrets

| Secret | Description | Where you got it |
|--------|-------------|-----------------|
| `VERIFY_CLIENT_ID` | IBM Verify OAuth app Client ID | Step 4.2 |
| `VERIFY_CLIENT_SECRET` | IBM Verify OAuth app Client Secret | Step 4.2 |
| `SLACK_SIGNING_SECRET` | Slack app signing secret | Step 2.3 |
| `GEMINI_API_KEY` | Google AI Studio API key | Step 3 |
| `WORKER_BASE_URL` | Your Worker's public URL | `https://askiam-bot.YOUR-ACCOUNT.workers.dev` |
| `CF_ACCESS_CLIENT_ID` | Cloudflare Access service token ID | Step 5.1 |
| `CF_ACCESS_CLIENT_SECRET` | Cloudflare Access service token secret | Step 5.1 |

---

## Step 8 — Entitle Users to Run /askiam

Every Slack user who runs `/askiam` must be **entitled** to the IBM Verify OAuth application you created in Step 4. Without entitlement, the sign-in flow will return a `401 Unauthorized` error.

### 8.1 Entitle individual users

1. In the IBM Verify admin console, go to **Applications → Applications**
2. Find and open the **AskIAM Slack Bot** application
3. Click the **Entitlements** tab
4. Click **Add entitlement**
5. Search for the user by name or email, select them, click **Save**
6. Repeat for each user who should have access

### 8.2 Entitle all users (optional)

If you want everyone in your tenant to be able to use `/askiam`:

1. In the IBM Verify admin console, go to **Applications → Applications**
2. Open **AskIAM Slack Bot** → **Entitlements** tab
3. Click **Add entitlement** → select **All users**
4. Click **Save**

---

## Step 9 — Test Everything End-to-End

### 9.1 Test the health endpoint

```bash
curl https://askiam-bot.YOUR-ACCOUNT.workers.dev/health
# Expected: {"status":"ok","worker":"askiam-bot"}
```

### 9.2 Run your first /askiam command

In any Slack channel where the bot is installed, type:

```
/askiam how many users do we have
```

**First time:** You will see a message like:

> 🔒 *AskIAM needs you to sign in with IBM Verify first.*
> [Click here to authenticate] — after sign-in your query will run automatically.
> *Link expires in 5 minutes.*

Click the link. You will be redirected to `YOUR-TENANT.verify.ibm.com` to sign in. After signing in, you will be redirected back and your original query runs automatically — the answer appears in Slack.

**Subsequent queries:** Your token is cached in KV. The answer appears immediately without any sign-in step.

### 9.3 Test a few more queries

```
/askiam list all groups
/askiam show my MFA enrollments
/askiam what apps can I request access to
/askiam show pending approvals
```

### 9.4 Test pagination

For queries that return many results (e.g. large user lists), the response will be paginated with **Next page** / **Previous page** buttons. Try:

```
/askiam list all applications
```

If your tenant has more than 25 applications, you'll see pagination buttons.

### 9.5 Test a write operation (admin only)

Write operations (password reset, user creation, etc.) require the user to be in the admin list. If you've configured `ADMIN_USERS`, try:

```
/askiam reset password for testuser@acme.com
```

You should see a confirmation button — click it to execute, or ignore it to cancel.

> If you see "Write operations require admin privileges", your Slack user ID hasn't been added to the admin list. See [Configuring admin users](#configuring-admin-users) below.

---

## How the Sign-In Flow Works

Understanding the OAuth flow helps when troubleshooting:

```
1. User runs /askiam (no token in KV)
   └── Worker generates a PKCE verifier + challenge
       stores {userId, verifier, query, responseUrl} in KV (5-min TTL)
       sends user an IBM Verify login link

2. User clicks the link → authenticates at IBM Verify
   └── IBM Verify redirects to /oauth/callback?code=...&state=...

3. Worker exchanges the code for tokens
   └── Stores access_token + refresh_token in KV under token:<userId>
       Runs the original query → posts answer to Slack

4. All future /askiam commands: token found in KV → runs immediately

5. If the access token expires (IBM Verify tokens last ~8 hours):
   └── Worker auto-refreshes using the refresh_token
       Stores new tokens → query runs transparently

6. If the refresh token expires:
   └── Worker deletes the KV entry → user prompted to sign in again
```

---

## Cloudflare KV — What Gets Stored

Your KV namespace (`ASKIAM_TOKENS`) stores three types of entries:

| Key pattern | Contents | TTL |
|-------------|----------|-----|
| `token:<slack_user_id>` | `{access_token, refresh_token}` for a user | 8 hours |
| `state:<nonce>` | `{userId, verifier, query, responseUrl}` for an in-progress OAuth flow | 5 minutes |
| `result:<hash>` | Cached large query result for pagination (shared across users) | 10 minutes |
| `confirm:<token>` | Pending write-operation confirmation | 5 minutes |

Inspect KV from the terminal:

```bash
# List all keys
wrangler kv key list --binding=ASKIAM_TOKENS

# Check if a specific user has a token (replace USER_ID with their Slack user ID)
wrangler kv key get --binding=ASKIAM_TOKENS "token:U0123456789"
```

Or browse it visually in the Cloudflare Dashboard → **Workers & Pages → KV → askiam-bot-ASKIAM_TOKENS → KV Pairs**.

---

## Configuring Admin Users

Write operations (password reset, user creation, etc.) are restricted to an admin list. This is configured via an optional environment variable.

### Setting the admin list

Add the `ADMIN_USERS` secret as a comma-separated list of Slack user IDs:

```bash
wrangler secret put ADMIN_USERS
# When prompted, enter: U0123456789,U9876543210
```

To find a Slack user's ID:
1. Click on their profile in Slack
2. Click the three-dot menu (⋯)
3. Click **Copy member ID**

---

## Troubleshooting

### "🔒 AskIAM needs you to sign in" on every query

The token stored in KV is expiring and the refresh is failing. Check:

1. The IBM Verify OAuth app still has the user entitled (Step 8)
2. The `VERIFY_CLIENT_ID` and `VERIFY_CLIENT_SECRET` secrets are correct
3. Check Worker logs for refresh errors:
   ```bash
   wrangler tail --format=pretty
   ```

### Sign-in link returns an error from IBM Verify

| Error message | Cause | Fix |
|---------------|-------|-----|
| `redirect_uri_mismatch` | Redirect URI in IBM Verify doesn't match Worker URL | Add the correct URI in Step 4.1 |
| `unauthorized_client` | OAuth app isn't configured for authorization_code grant | Enable Authorization code in Step 4.1 |
| `access_denied` | User not entitled to the application | Entitle the user in Step 8 |
| `Authentication session expired` | PKCE state TTL (5 min) expired | Run `/askiam` again and click the link promptly |

### "MCP server error 403" in Worker logs

The Cloudflare Access service token isn't working. Check:

1. `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` are set correctly
2. The Access Application in Zero Trust is configured for `mcp.baronia.work`
3. The WAF skip rule is in place and positioned above any geo-block rule (Step 5.3)

### Gemini routing fails — query returns "I didn't understand that"

```bash
wrangler tail --format=pretty
```

Look for `[Gemini route]` error lines. Common causes:

| Error | Fix |
|-------|-----|
| `401 Invalid API key` | Regenerate key at https://aistudio.google.com |
| `429 Quota exceeded` | Check your Google AI Studio usage dashboard |

Try rephrasing the query more explicitly, e.g. instead of "users" try "list all users" or "how many users are there".

### "Write operations require admin privileges"

Your Slack user ID is not in the `ADMIN_USERS` list. See [Configuring admin users](#configuring-admin-users).

### Results appear cut off / paginated unexpectedly

The page size is 25 rows. For large tenants (thousands of users/groups), results are paginated automatically. Use the **Next page** button in Slack, or ask for a more specific query: e.g. `/askiam list users in the Engineering department` instead of `/askiam list all users`.

---

## Example Queries Reference

### User management (admin)
```
/askiam how many users do we have
/askiam list users in the Engineering department
/askiam show profile for john@acme.com
/askiam find users created in the last 7 days
/askiam create a user jane.smith@acme.com, Jane Smith, in Finance
/askiam reset password for john@acme.com
```

### Group management (admin)
```
/askiam list all groups
/askiam find groups with Admin in the name
/askiam add sarah@acme.com to the Finance Approvers group
/askiam how many groups are there
```

### Application management (admin)
```
/askiam list all applications
/askiam show the config for the Salesforce app
/askiam what application types can I create
```

### MFA management (admin)
```
/askiam show MFA enrollments for john@acme.com
/askiam list all MFA enrollments in the tenant
/askiam which MFA methods are enabled in the tenant
```

### Access requests (self-service)
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

### My MFA (self-service)
```
/askiam show my MFA enrollments
/askiam delete my TOTP enrollment
```

---

## Useful Commands Reference

```bash
# Install dependencies
npm install

# Deploy (or redeploy after changes)
wrangler deploy

# Watch live logs
wrangler tail --format=pretty

# Add or update a secret
wrangler secret put SECRET_NAME

# List all secrets (names only)
wrangler secret list

# List KV keys
wrangler kv key list --binding=ASKIAM_TOKENS

# Check a user's token
wrangler kv key get --binding=ASKIAM_TOKENS "token:UXXXXXXXXXXX"

# Delete a user's token (forces them to re-authenticate)
wrangler kv key delete --binding=ASKIAM_TOKENS "token:UXXXXXXXXXXX"
```

---

## Files Reference

| File | Purpose |
|------|---------|
| `index.js` | Main Worker — `/slack/command`, `/oauth/callback`, `/slack/action`, `/health` routes |
| `wrangler.toml` | Cloudflare Worker config — name, KV binding |
| `slack-app-manifest.yaml` | Slack app manifest YAML — use in Step 2.1 |
| `slack-app-manifest.json` | Slack app manifest JSON — fallback for Step 2.1 if YAML is rejected |
| `shared/gemini.js` | `routeQuery()` — picks the MCP tool from the query; `answerQuery()` — formats the result |
| `shared/mcp-client.js` | `callTool()` — MCP Streamable HTTP session handshake + tools/call |

---

*Built with Cloudflare Workers · Google Gemini · IBM Verify SaaS OAuth 2.0 · Slack Block Kit*
