import { routeQuery, answerQuery } from './shared/gemini.js';
import { callTool } from './shared/mcp-client.js';

const VERIFY_BASE    = 'https://baronia.verify.ibm.com';
const AUTH_URL       = `${VERIFY_BASE}/oauth2/authorize`;
const TOKEN_URL      = `${VERIFY_BASE}/oauth2/token`;
const SCOPES         = 'openid profile';

const STATE_TTL_MS   = 5 * 60 * 1000;   // 5 min PKCE state
const RESULT_TTL_S   = 10 * 60;         // 10 min cached MCP result for pagination
const PAGE_SIZE      = 10;

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
  return `v0=${hex}` === signature;
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
function estimateRowCount(rawResult) {
  return (rawResult.match(/\n/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// Core AskIAM execution — assumes a valid access token
// ---------------------------------------------------------------------------
async function executeQuery(query, accessToken, responseUrl, env, page = 0, mode = 'page') {
  const route = await routeQuery(query, env.GEMINI_API_KEY);
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

  const rawResult = await callTool(route.toolName, route.args, accessToken, {
    clientId:     env.CF_ACCESS_CLIENT_ID,
    clientSecret: env.CF_ACCESS_CLIENT_SECRET,
    persona:      route.persona,
  });

  // Store raw result in KV for pagination buttons (10-min TTL)
  const cacheKey = `result:${randomState()}`;
  await env.ASKIAM_TOKENS.put(cacheKey, JSON.stringify({
    query, toolName: route.toolName, rawResult,
  }), { expirationTtl: RESULT_TTL_S });

  const pageSize  = mode === 'all' ? 0 : PAGE_SIZE;
  const answer    = await answerQuery(query, route.toolName, rawResult, env.GEMINI_API_KEY, page, pageSize);
  // Use Gemini's footer field to detect truncation — it contains "showing X of Y" when more exist
  const hasMore   = mode !== 'all' && typeof answer === 'object' && !!answer.footer;
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

      // ── Suggested query button ───────────────────────────────────────────
      if (actionData.suggestedQuery) {
        const userId = payload.user?.id ?? '';
        const stored = await env.ASKIAM_TOKENS.get(`token:${userId}`, { type: 'json' }).catch(() => null);
        if (!stored?.access_token) {
          await postToResponseUrl(responseUrl, '🔒 Session expired — run `/askiam` again to re-authenticate.');
          return;
        }
        // Post the result directly — no intermediate ack to avoid stale messages
        await executeQuery(actionData.suggestedQuery, stored.access_token, responseUrl, env);
        return;
      }

      // ── Pagination button ────────────────────────────────────────────────
      const { cacheKey, page, mode } = actionData;
      const cached = await env.ASKIAM_TOKENS.get(cacheKey, { type: 'json' }).catch(() => null);

      if (!cached) {
        await postToResponseUrl(responseUrl, '⚠️ Results expired — please run your `/askiam` query again.');
        return;
      }

      const { query, toolName, rawResult } = cached;
      const pageSize = mode === 'all' ? 0 : PAGE_SIZE;
      const answer   = await answerQuery(query, toolName, rawResult, env.GEMINI_API_KEY, page, pageSize);
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
        await executeQuery(query, stored.access_token, responseUrl, env);
      } catch (err) {
        if (stored.refresh_token && err.message.includes('401')) {
          try {
            const refreshed = await refreshAccessToken(stored.refresh_token, env);
            await env.ASKIAM_TOKENS.put(`token:${userId}`, JSON.stringify({
              access_token:  refreshed.access_token,
              refresh_token: refreshed.refresh_token ?? stored.refresh_token,
            }));
            await executeQuery(query, refreshed.access_token, responseUrl, env);
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
async function handleOAuthCallback(request, env) {
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

  await env.ASKIAM_TOKENS.put(`token:${stored.userId}`, JSON.stringify({
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
  }));

  if (stored.query && stored.responseUrl) {
    executeQuery(stored.query, tokens.access_token, stored.responseUrl, env)
      .catch(err => console.error('[OAuth callback query]', err.message));
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
        return handleOAuthCallback(request, env);
      case '/health':
        return new Response(JSON.stringify({ status: 'ok', worker: 'askiam-bot' }),
          { headers: { 'Content-Type': 'application/json' } });
      default:
        return new Response('Not found', { status: 404 });
    }
  },
};
