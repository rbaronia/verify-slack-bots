import { routeQuery, answerQuery } from './shared/gemini.js';
import { callTool } from './shared/mcp-client.js';

const VERIFY_BASE    = 'https://baronia.verify.ibm.com';
const AUTH_URL       = `${VERIFY_BASE}/oauth2/authorize`;
const TOKEN_URL      = `${VERIFY_BASE}/oauth2/token`;
const SCOPES         = 'openid profile';

// How long (ms) to keep the PKCE state entry while waiting for the user to
// click the auth link.  5 minutes is generous.
const STATE_TTL_MS   = 5 * 60 * 1000;

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
// Helpers — Slack response_url posting
// ---------------------------------------------------------------------------
async function postToResponseUrl(responseUrl, text) {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', text }),
  });
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
// Core AskIAM execution — assumes a valid access token
// ---------------------------------------------------------------------------
async function executeQuery(query, accessToken, responseUrl, env) {
  const route = await routeQuery(query, env.GEMINI_API_KEY);
  if (!route) {
    await postToResponseUrl(responseUrl,
      '*AskIAM* — I didn\'t understand that query. Try:\n' +
      '• `/askiam count all users`\n' +
      '• `/askiam list users in Engineering`\n' +
      '• `/askiam list all groups`\n' +
      '• `/askiam list applications`\n' +
      '• `/askiam show MFA enrollments for <user_id>`'
    );
    return;
  }
  const result = await callTool(route.toolName, route.args, accessToken);
  const answer = await answerQuery(query, route.toolName, result, env.GEMINI_API_KEY);
  await postToResponseUrl(responseUrl, answer);
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
        '*AskIAM* — Usage: `/askiam <question>`\nExamples:\n' +
        '• `/askiam count all users`\n• `/askiam list all groups`\n' +
        '• `/askiam list applications`\n• `/askiam show MFA for <user_id>`'
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  // --- Check KV for an existing token ---
  const stored = await env.ASKIAM_TOKENS.get(`token:${userId}`, { type: 'json' }).catch(() => null);

  if (stored?.access_token) {
    // Fire query in background; return ack immediately
    ctx.waitUntil((async () => {
      try {
        await executeQuery(query, stored.access_token, responseUrl, env);
      } catch (err) {
        // If the token is stale, try refreshing once
        if (stored.refresh_token && err.message.includes('401')) {
          try {
            const refreshed = await refreshAccessToken(stored.refresh_token, env);
            await env.ASKIAM_TOKENS.put(`token:${userId}`, JSON.stringify({
              access_token:  refreshed.access_token,
              refresh_token: refreshed.refresh_token ?? stored.refresh_token,
            }));
            await executeQuery(query, refreshed.access_token, responseUrl, env);
          } catch (refreshErr) {
            // Refresh failed — clear token and ask user to re-auth
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
      JSON.stringify({ response_type: 'ephemeral', text: '🔍 Looking that up...' }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  // --- No token — start OAuth flow ---
  const { verifier, challenge } = await generatePKCE();
  const state       = randomState();
  const redirectUri = `${env.WORKER_BASE_URL}/oauth/callback`;

  // Store PKCE state + original query in KV (TTL = 5 min)
  await env.ASKIAM_TOKENS.put(`state:${state}`, JSON.stringify({
    userId,
    verifier,
    query,
    responseUrl,
    redirectUri,
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

  // Retrieve PKCE state
  const stored = await env.ASKIAM_TOKENS.get(`state:${state}`, { type: 'json' }).catch(() => null);
  if (!stored) {
    return new Response('<html><body><p>Authentication session expired or already used. Please run <code>/askiam</code> again.</p></body></html>',
      { status: 400, headers: { 'Content-Type': 'text/html' } });
  }

  // Clean up state entry immediately (one-time use)
  await env.ASKIAM_TOKENS.delete(`state:${state}`);

  // Exchange code for tokens
  let tokens;
  try {
    tokens = await exchangeCode(code, stored.verifier, stored.redirectUri, env);
  } catch (err) {
    console.error('[OAuth callback]', err.message);
    return new Response(`<html><body><p>Token exchange failed: ${err.message}. Please try again.</p></body></html>`,
      { status: 500, headers: { 'Content-Type': 'text/html' } });
  }

  // Persist token in KV (no TTL — we rely on refresh)
  await env.ASKIAM_TOKENS.put(`token:${stored.userId}`, JSON.stringify({
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
  }));

  // Fire the original query in the background
  if (stored.query && stored.responseUrl) {
    // Can't use ctx.waitUntil here (no ctx in this route handler),
    // so fire-and-forget with a plain untracked promise — acceptable since
    // the callback response is a static HTML page the user immediately closes.
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
