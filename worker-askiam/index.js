/**
 * @file index.js
 * @description Cloudflare Worker entry point for the AskIAM Slack bot.
 *
 * AskIAM lets Slack users query IBM Verify IAM in natural language via
 * the /askiam slash command. Queries are routed by an LLM to the correct
 * IBM Verify MCP tool, results are formatted into Slack Block Kit messages,
 * and returned ephemerally to the requesting user.
 *
 * Request flow
 * ────────────
 * 1. POST /slack/command  — Slack delivers the /askiam slash command here.
 *    a. If the user has a valid cached token → executeQuery() in waitUntil.
 *    b. If no token → start OAuth 2.0 PKCE flow, send auth link to Slack.
 *
 * 2. GET  /oauth/callback — IBM Verify redirects here after user login.
 *    Exchanges the auth code for tokens, stores them in KV, then fires
 *    the original query automatically via ctx.waitUntil().
 *
 * 3. POST /slack/action   — Slack delivers Block Kit button interactions here.
 *    Handles: write-op confirm/cancel, suggested query buttons, pagination.
 *
 * 4. GET  /health         — Unauthenticated liveness probe. Returns {"status":"ok"}.
 *
 * KV namespace: ASKIAM_TOKENS
 * ────────────────────────────
 * Key prefix      TTL       Value
 * token:<uid>     8 h       { access_token, refresh_token }
 * state:<s>       5 min     { userId, verifier, query, responseUrl, redirectUri }
 * result:<uid>:<r> 10 min   { query, toolName, rawResult }  — pagination cache
 * confirm:<t>     5 min     { route, query, userId }         — pending write-op
 * config:admin_users  none  JSON array of Slack user IDs with write access
 *
 * Required secrets (set with `wrangler secret put`)
 * ──────────────────────────────────────────────────
 * VERIFY_CLIENT_ID      — IBM Verify OAuth app client ID
 * VERIFY_CLIENT_SECRET  — IBM Verify OAuth app client secret
 * SLACK_SIGNING_SECRET  — Slack app signing secret for request verification
 * GEMINI_API_KEY        — Google AI Studio API key
 * GROQ_API_KEY          — Groq API key (LLM fallback)
 * WORKER_BASE_URL       — Public base URL of this Worker (for OAuth redirect URI)
 * CF_ACCESS_CLIENT_ID   — Cloudflare Access service token ID (MCP server bypass)
 * CF_ACCESS_CLIENT_SECRET — Cloudflare Access service token secret
 *
 * Security controls implemented
 * ──────────────────────────────
 * C1 — Write-op authz: WRITE_TOOLS set + KV admin list + confirmation button
 * C2 — Prompt injection: sanitiseQuery() called before every LLM invocation
 * C3 — responseUrl SSRF guard: must be https://hooks.slack.com/ prefix
 * H4 — Token TTL: 8-hour expiry on all KV token writes
 * H5 — Empty userId guard in action handler
 * M10 — Cache keys scoped to userId
 */

import { routeQuery, answerQuery, sanitiseQuery } from './shared/gemini.js';
import { callTool } from './shared/mcp-client.js';

const VERIFY_BASE    = 'https://baronia.verify.ibm.com';
const AUTH_URL       = `${VERIFY_BASE}/oauth2/authorize`;
const TOKEN_URL      = `${VERIFY_BASE}/oauth2/token`;
const SCOPES         = 'openid profile';

const STATE_TTL_MS   = 5 * 60 * 1000;   // 5 min PKCE state
const RESULT_TTL_S   = 10 * 60;         // 10 min cached MCP result for pagination
const PAGE_SIZE      = 25;
// ---------------------------------------------------------------------------
// C1 — Write-operation tool registry + admin authorisation
// ---------------------------------------------------------------------------
const WRITE_TOOLS = new Set([
  'ibm_verify_delete_user',
  'ibm_verify_delete_group',
  'ibm_verify_delete_application',
  'ibm_verify_reset_user_password',
  'ibm_verify_create_user',
  'ibm_verify_update_user',
  'ibm_verify_update_group',
  'ibm_verify_delete_mfa_enrollment',
  'ibm_verify_review_access_request',
  'ibm_verify_create_application',
  'ibm_verify_update_application',
]);

// Returns the array of admin Slack user IDs stored in KV, or [] if not set.
async function getAdminUsers(env) {
  return await env.ASKIAM_TOKENS.get('config:admin_users', { type: 'json' }).catch(() => null) ?? [];
}

// ---------------------------------------------------------------------------
// Helpers — PKCE
// ---------------------------------------------------------------------------
function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generatePKCE() {
  const verifier  = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  );
  return { verifier, challenge };
}

function randomState() {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

// ---------------------------------------------------------------------------
// Helpers — Slack signature verification (HMAC-SHA256)
// ---------------------------------------------------------------------------
// Constant-time string comparison — prevents timing oracle on HMAC secrets.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

async function verifySlackSignature(rawBody, signingSecret, request) {
  const timestamp = request.headers.get('X-Slack-Request-Timestamp');
  const signature = request.headers.get('X-Slack-Signature');
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sigBase));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  const expected = `v0=${hex}`;
  // Constant-time comparison prevents timing-based secret extraction
  return timingSafeEqual(expected, signature);
}

// ---------------------------------------------------------------------------
// Helpers — Slack posting
// ---------------------------------------------------------------------------
async function postToResponseUrl(responseUrl, payload) {
  const body = typeof payload === 'string'
    ? { response_type: 'ephemeral', text: payload }
    : { response_type: 'ephemeral', replace_original: false, ...payload };
  const resp = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    console.error('[postToResponseUrl]', resp.status, t.slice(0, 200));
  }
}

// Build a Slack Block Kit message from a structured Gemini response.
// C1 — Confirmation block for write operations
// pending write stored in KV: confirm:<token> → { route, query, userId }
const CONFIRM_TTL_S = 5 * 60; // 5 min to click confirm

async function postWriteConfirmation(responseUrl, route, query, userId, env) {
  const confirmToken = randomState();
  await env.ASKIAM_TOKENS.put(`confirm:${confirmToken}`, JSON.stringify({
    route, query, userId,
  }), { expirationTtl: CONFIRM_TTL_S });

  const toolLabel = route.toolName.replace('ibm_verify_', '').replace(/_/g, ' ');
  const argsText  = Object.keys(route.args).length
    ? `\n*Args:* ${JSON.stringify(route.args)}`
    : '';

  await postToResponseUrl(responseUrl, {
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn',
          text: `⚠️ *Confirm write operation*\n*Tool:* \`${toolLabel}\`${argsText}\n_This action may be irreversible. Are you sure?_` },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'danger',
            text: { type: 'plain_text', text: '✅ Yes, proceed', emoji: true },
            action_id: 'askiam_confirm_write',
            value: JSON.stringify({ confirmToken }),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ Cancel', emoji: true },
            action_id: 'askiam_cancel_write',
            value: JSON.stringify({ confirmToken }),
          },
        ],
      },
    ],
    text: `Confirm write operation: ${toolLabel}`,
  });
}

// answer   — { query, summary, bullets, footer } from answerQuery()
// cacheKey — KV key for the stored raw result
// page     — current 0-based page
// hasMore  — whether there are more pages
// Suggested follow-up queries shown at the bottom of every response.
const SUGGESTED_QUERIES = [
  { label: '🔑 My access',         query: 'what access do I have' },
  { label: '📋 Pending approvals', query: 'show pending approvals' },
  { label: '📬 My requests',       query: 'show my access requests' },
  { label: '🔐 My MFA',            query: 'show my MFA enrollments' },
  { label: '🛒 Request access',    query: 'what apps can I request access to' },
];

function buildBlockKitMessage(answer, cacheKey, page, hasMore) {
  // answer may be a plain string on fallback — handle gracefully
  if (typeof answer === 'string') {
    return { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: answer } }], text: answer };
  }

  const { query = '', summary = '', bullets = [], footer = '' } = answer;
  const blocks = [];

  // ── Query header ──────────────────────────────────────────────────────────
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `🔍 *Query:* _${query}_` }],
  });
  blocks.push({ type: 'divider' });

  // ── Summary ───────────────────────────────────────────────────────────────
  if (summary) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: summary },
    });
  }

  // ── Bullet list ───────────────────────────────────────────────────────────
  if (bullets.length > 0) {
    blocks.push({ type: 'divider' });
    for (let i = 0; i < bullets.length; i += 10) {
      const chunk = bullets.slice(i, i + 10).map(b => `• ${b}`).join('\n');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
    }
  }

  // ── Footer + pagination ───────────────────────────────────────────────────
  const footerElements = [];
  if (footer) footerElements.push({ type: 'mrkdwn', text: `_${footer}_` });

  if (cacheKey && hasMore) {
    // Pagination buttons: "Show next 10" and "Show all"
    if (footerElements.length) blocks.push({ type: 'context', elements: footerElements });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: `⬇️  Show next ${PAGE_SIZE}`, emoji: true },
          action_id: 'askiam_next_page',
          value: JSON.stringify({ cacheKey, page: page + 1, mode: 'page' }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📋  Show all', emoji: true },
          action_id: 'askiam_show_all',
          value: JSON.stringify({ cacheKey, page: 0, mode: 'all' }),
        },
      ],
    });
  } else if (footerElements.length) {
    blocks.push({ type: 'context', elements: footerElements });
  }

  // ── Suggested queries ─────────────────────────────────────────────────────
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '*Try asking:*' }],
  });
  blocks.push({
    type: 'actions',
    elements: SUGGESTED_QUERIES.map(s => ({
      type: 'button',
      text: { type: 'plain_text', text: s.label, emoji: true },
      action_id: `askiam_suggest_${s.label.replace(/\W+/g, '_')}`,
      value: JSON.stringify({ suggestedQuery: s.query }),
    })),
  });

  const fallbackText = `${query} — ${summary}`;
  return { blocks, text: fallbackText };
}

// ---------------------------------------------------------------------------
// IBM Verify token exchange — auth code → tokens
// ---------------------------------------------------------------------------
async function exchangeCode(code, verifier, redirectUri, env) {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     env.VERIFY_CLIENT_ID,
      client_secret: env.VERIFY_CLIENT_SECRET,
      code,
      redirect_uri:  redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`token exchange failed ${resp.status}: ${err.slice(0, 200)}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// IBM Verify token refresh
// ---------------------------------------------------------------------------
async function refreshAccessToken(refreshToken, env) {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     env.VERIFY_CLIENT_ID,
      client_secret: env.VERIFY_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });
  if (!resp.ok) throw new Error(`refresh failed: ${resp.status}`);
  return resp.json();
}

// ---------------------------------------------------------------------------
// Estimate whether a raw MCP result string likely contains more than one page.
// We count newlines as a rough proxy for rows — good enough to decide on buttons.
// ---------------------------------------------------------------------------
async function hashKey(...parts) {
  const data = new TextEncoder().encode(parts.join('|'));
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return base64url(buf).slice(0, 16);
}


function estimateRowCount(rawResult) {
  return (rawResult.match(/\n/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// Core AskIAM execution — assumes a valid access token
// userId is required for write-op authz checks.
// ---------------------------------------------------------------------------
async function executeQuery(query, accessToken, responseUrl, env, userId = '', page = 0, mode = 'page') {
  // C2 — sanitise before sending to LLM
  let safeQuery;
  try {
    safeQuery = sanitiseQuery(query);
  } catch (err) {
    await postToResponseUrl(responseUrl, `🚫 ${err.message}`);
    return;
  }

  const route = await routeQuery(safeQuery, env.GEMINI_API_KEY, env.GROQ_API_KEY);
  if (!route) {
    await postToResponseUrl(responseUrl,
      '*AskIAM* — I didn\'t understand that query. Try:\n' +
      '• `/askiam how many users do we have`\n' +
      '• `/askiam show my access requests`\n' +
      '• `/askiam what apps can I request access to`\n' +
      '• `/askiam show my MFA enrollments`\n' +
      '• `/askiam show pending approvals`\n' +
      '• `/askiam list all groups`\n' +
      '• `/askiam reset password for john@example.com`'
    );
    return;
  }

  // C1 — write-op authz: check admin list, then require confirmation
  if (WRITE_TOOLS.has(route.toolName)) {
    const admins = await getAdminUsers(env);
    if (!admins.includes(userId)) {
      await postToResponseUrl(responseUrl,
        '🚫 *Write operations require admin privileges.*\n' +
        'Contact your IAM administrator to be added to the AskIAM admin list.'
      );
      return;
    }
    // Admin confirmed — post a confirmation button before executing
    await postWriteConfirmation(responseUrl, route, safeQuery, userId, env);
    return;
  }

  const rawResult = await callTool(route.toolName, route.args, accessToken, {
    clientId:     env.CF_ACCESS_CLIENT_ID,
    clientSecret: env.CF_ACCESS_CLIENT_SECRET,
    persona:      route.persona,
  });

  // Only cache in KV when the result is large enough to need pagination.
  // This avoids a KV write on every single query (count queries, summaries, etc.)
  // and keeps us well within the free-tier 1,000 puts/day limit.
  const needsPagination = mode !== 'all' && estimateRowCount(rawResult) > PAGE_SIZE;
  let cacheKey = null;
  if (needsPagination) {
    // Shared cache key (no userId) so all users querying the same tool+args
    // reuse one KV slot instead of each burning a separate put.
    cacheKey = `result:${await hashKey(route.toolName, JSON.stringify(route.args))}`;
    const existing = await env.ASKIAM_TOKENS.get(cacheKey, { type: 'json' }).catch(() => null);
    if (!existing || existing.rawResult !== rawResult) {
      await env.ASKIAM_TOKENS.put(cacheKey, JSON.stringify({
        query, toolName: route.toolName, rawResult,
      }), { expirationTtl: RESULT_TTL_S });
    }
  }

  const pageSize  = needsPagination ? PAGE_SIZE : 0;
  const answer    = await answerQuery(query, route.toolName, rawResult, env.GEMINI_API_KEY, env.GROQ_API_KEY, page, pageSize);
  const hasMore   = needsPagination && typeof answer === 'object' && !!answer.footer;
  const msg       = buildBlockKitMessage(answer, cacheKey, page, hasMore);
  await postToResponseUrl(responseUrl, msg);
}

// ---------------------------------------------------------------------------
// Route: POST /slack/action  (Block Kit button callbacks)
// ---------------------------------------------------------------------------
async function handleAction(request, env, ctx) {
  const rawBody = await request.text();

  const valid = await verifySlackSignature(rawBody, env.SLACK_SIGNING_SECRET, request);
  if (!valid) return new Response('Unauthorized', { status: 401 });

  // Slack sends payload as URL-encoded JSON in the 'payload' field
  const params  = new URLSearchParams(rawBody);
  const payload = JSON.parse(params.get('payload') ?? '{}');

  const action      = payload.actions?.[0];
  const responseUrl = payload.response_url;

  if (!action || !responseUrl) {
    return new Response('ok', { status: 200 });
  }

  // Ack immediately — Slack requires a response within 3s
  ctx.waitUntil((async () => {
    try {
      const actionData = JSON.parse(action.value ?? '{}');

      const userId = payload.user?.id;
      if (!userId) {
        await postToResponseUrl(responseUrl, '🔒 Cannot identify user. Please re-run `/askiam`.');
        return;
      }

      // ── Write-op confirmation button ─────────────────────────────────────
      if (action.action_id === 'askiam_cancel_write') {
        await postToResponseUrl(responseUrl, '↩️ Operation cancelled.');
        const { confirmToken } = actionData;
        if (confirmToken) await env.ASKIAM_TOKENS.delete(`confirm:${confirmToken}`).catch(() => {});
        return;
      }

      if (action.action_id === 'askiam_confirm_write') {
        const { confirmToken } = actionData;
        const pending = await env.ASKIAM_TOKENS.get(`confirm:${confirmToken}`, { type: 'json' }).catch(() => null);
        if (!pending) {
          await postToResponseUrl(responseUrl, '⚠️ Confirmation expired — please re-run your query.');
          return;
        }
        // Verify the confirming user is the same one who triggered the query
        if (pending.userId !== userId) {
          await postToResponseUrl(responseUrl, '🚫 Only the user who initiated this operation can confirm it.');
          return;
        }
        await env.ASKIAM_TOKENS.delete(`confirm:${confirmToken}`).catch(() => {});
        const stored = await env.ASKIAM_TOKENS.get(`token:${userId}`, { type: 'json' }).catch(() => null);
        if (!stored?.access_token) {
          await postToResponseUrl(responseUrl, '🔒 Session expired — run `/askiam` again to re-authenticate.');
          return;
        }
        const rawResult = await callTool(pending.route.toolName, pending.route.args, stored.access_token, {
          clientId:     env.CF_ACCESS_CLIENT_ID,
          clientSecret: env.CF_ACCESS_CLIENT_SECRET,
          persona:      pending.route.persona,
        });
        const answer = await answerQuery(pending.query, pending.route.toolName, rawResult, env.GEMINI_API_KEY, env.GROQ_API_KEY);
        const msg    = buildBlockKitMessage(answer, null, 0, false);
        await postToResponseUrl(responseUrl, msg);
        return;
      }

      // ── Suggested query button ───────────────────────────────────────────
      if (actionData.suggestedQuery) {
        const stored = await env.ASKIAM_TOKENS.get(`token:${userId}`, { type: 'json' }).catch(() => null);
        if (!stored?.access_token) {
          await postToResponseUrl(responseUrl, '🔒 Session expired — run `/askiam` again to re-authenticate.');
          return;
        }
        // Post the result directly — no intermediate ack to avoid stale messages
        await executeQuery(actionData.suggestedQuery, stored.access_token, responseUrl, env, userId);
        return;
      }

      // ── Pagination button ────────────────────────────────────────────────
      const { cacheKey, page, mode } = actionData;
      // Guard: only allow keys matching the expected result:<userId>:<hash> pattern
      // to prevent arbitrary KV reads from a manipulated button payload.
      if (!cacheKey || !/^result:[A-Z0-9]+:[0-9a-f]{16,}$/i.test(cacheKey)) {
        await postToResponseUrl(responseUrl, '⚠️ Invalid pagination token.');
        return;
      }
      const cached = await env.ASKIAM_TOKENS.get(cacheKey, { type: 'json' }).catch(() => null);

      if (!cached) {
        await postToResponseUrl(responseUrl, '⚠️ Results expired — please run your `/askiam` query again.');
        return;
      }

      const { query, toolName, rawResult } = cached;
      const pageSize = mode === 'all' ? 0 : PAGE_SIZE;
      const answer   = await answerQuery(query, toolName, rawResult, env.GEMINI_API_KEY, env.GROQ_API_KEY, page, pageSize);
      const hasMore  = mode !== 'all' && typeof answer === 'object' && !!answer.footer;
      const msg      = buildBlockKitMessage(answer, cacheKey, page, hasMore);

      await fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replace_original: true, response_type: 'ephemeral', ...msg }),
      });
    } catch (err) {
      console.error('[AskIAM action]', err.message);
      await postToResponseUrl(responseUrl, `❌ Error: ${err.message}`);
    }
  })());

  return new Response('', { status: 200 });
}

// ---------------------------------------------------------------------------
// Route: POST /slack/command  (/askiam)
// ---------------------------------------------------------------------------
async function handleSlashCommand(request, env, ctx) {
  const rawBody = await request.text();

  const valid = await verifySlackSignature(rawBody, env.SLACK_SIGNING_SECRET, request);
  if (!valid) return new Response('Unauthorized', { status: 401 });

  const params      = new URLSearchParams(rawBody);
  const userId      = params.get('user_id') ?? '';
  const query       = (params.get('text') ?? '').trim();
  const responseUrl = params.get('response_url') ?? '';

  if (!query) {
    return new Response(
      JSON.stringify({ response_type: 'ephemeral', text:
        '*AskIAM* — Usage: `/askiam <question>`\n\n' +
        '*Admin:* users · groups · applications · MFA · directory\n' +
        '• `/askiam how many users do we have`\n' +
        '• `/askiam list groups with Admin in the name`\n' +
        '• `/askiam reset password for john@acme.com`\n\n' +
        '*Self-service:* access requests · my MFA · password reset\n' +
        '• `/askiam what apps can I request access to`\n' +
        '• `/askiam show my pending access requests`\n' +
        '• `/askiam show pending approvals`\n' +
        '• `/askiam show my MFA enrollments`'
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  // --- Check KV for an existing token ---
  const stored = await env.ASKIAM_TOKENS.get(`token:${userId}`, { type: 'json' }).catch(() => null);

  if (stored?.access_token) {
    ctx.waitUntil((async () => {
      try {
        // Validate responseUrl before using it — guard against SSRF from a
        // manipulated stored token entry.
        if (!responseUrl.startsWith('https://hooks.slack.com/')) {
          console.error('[AskIAM] suspicious responseUrl rejected:', responseUrl.slice(0, 80));
          return;
        }
        await executeQuery(query, stored.access_token, responseUrl, env, userId);
      } catch (err) {
        if (stored.refresh_token && err.message.includes('401')) {
          try {
            const refreshed = await refreshAccessToken(stored.refresh_token, env);
            const newRefresh = refreshed.refresh_token ?? stored.refresh_token;
            // Only write if the tokens actually changed (avoids a KV put when
            // a concurrent request already refreshed the same token).
            if (refreshed.access_token !== stored.access_token || newRefresh !== stored.refresh_token) {
              // TOKEN_TTL_S: IBM Verify tokens live ~8 h; store with matching TTL
              const TOKEN_TTL_S = 8 * 60 * 60;
              await env.ASKIAM_TOKENS.put(`token:${userId}`, JSON.stringify({
                access_token:  refreshed.access_token,
                refresh_token: newRefresh,
              }), { expirationTtl: TOKEN_TTL_S });
            }
            await executeQuery(query, refreshed.access_token, responseUrl, env, userId);
          } catch {
            await env.ASKIAM_TOKENS.delete(`token:${userId}`);
            await postToResponseUrl(responseUrl, '🔒 Your session expired. Please run `/askiam` again to re-authenticate.');
          }
        } else {
          console.error('[AskIAM]', err.message);
          await postToResponseUrl(responseUrl, `❌ Error: ${err.message}`);
        }
      }
    })());

    return new Response(
      JSON.stringify({ response_type: 'ephemeral', text: '🔎 On it — checking IBM Verify...' }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  // --- No token — start OAuth flow ---
  const { verifier, challenge } = await generatePKCE();
  const state       = randomState();
  const redirectUri = `${env.WORKER_BASE_URL}/oauth/callback`;

  await env.ASKIAM_TOKENS.put(`state:${state}`, JSON.stringify({
    userId, verifier, query, responseUrl, redirectUri,
  }), { expirationTtl: Math.ceil(STATE_TTL_MS / 1000) });

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('response_type',         'code');
  authUrl.searchParams.set('client_id',             env.VERIFY_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri',          redirectUri);
  authUrl.searchParams.set('scope',                 SCOPES);
  authUrl.searchParams.set('state',                 state);
  authUrl.searchParams.set('code_challenge',        challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return new Response(
    JSON.stringify({
      response_type: 'ephemeral',
      text: `🔒 *AskIAM needs you to sign in with IBM Verify first.*\n<${authUrl.toString()}|Click here to authenticate> — after sign-in your query will run automatically.\n_Link expires in 5 minutes._`,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

// ---------------------------------------------------------------------------
// Route: GET /oauth/callback
// ---------------------------------------------------------------------------
async function handleOAuthCallback(request, env, ctx) {
  const url   = new URL(request.url);
  const code  = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return new Response(`<html><body><p>Authentication failed: ${error}. You can close this tab.</p></body></html>`,
      { status: 400, headers: { 'Content-Type': 'text/html' } });
  }

  if (!code || !state) {
    return new Response('<html><body><p>Invalid callback — missing code or state.</p></body></html>',
      { status: 400, headers: { 'Content-Type': 'text/html' } });
  }

  const stored = await env.ASKIAM_TOKENS.get(`state:${state}`, { type: 'json' }).catch(() => null);
  if (!stored) {
    return new Response('<html><body><p>Authentication session expired or already used. Please run <code>/askiam</code> again.</p></body></html>',
      { status: 400, headers: { 'Content-Type': 'text/html' } });
  }

  await env.ASKIAM_TOKENS.delete(`state:${state}`);

  let tokens;
  try {
    tokens = await exchangeCode(code, stored.verifier, stored.redirectUri, env);
  } catch (err) {
    console.error('[OAuth callback]', err.message);
    return new Response(`<html><body><p>Token exchange failed: ${err.message}. Please try again.</p></body></html>`,
      { status: 500, headers: { 'Content-Type': 'text/html' } });
  }

  // TOKEN_TTL_S: IBM Verify tokens live ~8 h; bound KV entry to same window
  // so stale tokens are automatically evicted rather than persisting forever.
  const TOKEN_TTL_S = 8 * 60 * 60;
  await env.ASKIAM_TOKENS.put(`token:${stored.userId}`, JSON.stringify({
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
  }), { expirationTtl: TOKEN_TTL_S });

  // C3 — validate responseUrl before using it, register in waitUntil
  if (stored.query && stored.responseUrl) {
    if (!stored.responseUrl.startsWith('https://hooks.slack.com/')) {
      console.error('[OAuth callback] suspicious responseUrl rejected:', stored.responseUrl.slice(0, 80));
    } else {
      ctx.waitUntil(
        executeQuery(stored.query, tokens.access_token, stored.responseUrl, env, stored.userId)
          .catch(err => console.error('[OAuth callback query]', err.message))
      );
    }
  }

  return new Response(
    '<html><body style="font-family:sans-serif;padding:2rem">' +
    '<h2>✅ Authenticated!</h2>' +
    '<p>You\'re signed in with IBM Verify. Your AskIAM query is running — check Slack for the result.</p>' +
    '<p>You can close this tab.</p>' +
    '</body></html>',
    { headers: { 'Content-Type': 'text/html' } },
  );
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/slack/command':
        return handleSlashCommand(request, env, ctx);
      case '/slack/action':
        return handleAction(request, env, ctx);
      case '/oauth/callback':
        return handleOAuthCallback(request, env, ctx);
      case '/health':
        return new Response(JSON.stringify({ status: 'ok', worker: 'askiam-bot' }),
          { headers: { 'Content-Type': 'application/json' } });
      default:
        return new Response('Not found', { status: 404 });
    }
  },
};
