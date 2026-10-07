import { classifyEvent, generateDailySummary, generatePeriodInsights, generateSectionCommentary } from './shared/gemini.js';
import { getToken } from './shared/mcp-client.js';
import {
  buildAlertBlock, buildDailySummaryBlock, buildPeriodSummaryBlock,
  buildReportControlPanel, buildIdentityDrilldown, buildCategoryDrilldown,
  buildActionsDrilldown, buildUsersDrilldown,
  postToWebhook, postToResponseUrl,
} from './shared/slack.js';
import { fetchEventsSince } from './shared/verify-events.js';

// ---------------------------------------------------------------------------
// Slack signature verification (HMAC-SHA256)
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
  const hex = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  const expected = `v0=${hex}`;
  return expected === signature;
}

// ---------------------------------------------------------------------------
// Route: POST /verify-webhook
// ---------------------------------------------------------------------------
async function handleVerifyWebhook(request, env, ctx) {
  const body = await request.text();

  if (request.headers.get('X-Verify-Secret') !== env.VERIFY_WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const event = JSON.parse(body);
  const c = await classifyEvent(event, env.GEMINI_API_KEY);

  if (c.severity >= parseInt(env.SEVERITY_THRESHOLD ?? '6', 10)) {
    const blocks = buildAlertBlock(event, c);
    await postToWebhook(env.SLACK_ALERT_WEBHOOK_URL, blocks, c.summary);
    console.log('[ALERT]', event.event_type, event.data?.action, 'severity=' + c.severity);
  } else {
    console.log('[SKIP]', 'severity=' + c.severity, event.data?.action);
  }

  return new Response('OK', { status: 200 });
}

// ---------------------------------------------------------------------------
// Route: POST /slack/command  (/report only — /askiam moved to askiam-bot)
// ---------------------------------------------------------------------------
async function handleSlashCommand(request, env, ctx) {
  const rawBody = await request.text();

  const valid = await verifySlackSignature(rawBody, env.SLACK_SIGNING_SECRET, request);
  if (!valid) return new Response('Unauthorized', { status: 401 });

  const params = new URLSearchParams(rawBody);
  const text   = (params.get('text') ?? '').trim();

  const days = [7, 30, 90].includes(Number(text)) ? Number(text) : null;
  if (days) {
    ctx.waitUntil(
      handlePeriodSummary(env, days).catch(err =>
        console.error('[report command]', err.message)
      )
    );
    return new Response(
      JSON.stringify({ response_type: 'ephemeral', text: `Generating ${days}-day report — it will appear in the channel shortly.` }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }
  // No args — post the button control panel to the channel
  const blocks = buildReportControlPanel();
  return new Response(
    JSON.stringify({ response_type: 'in_channel', blocks, text: 'IBM Verify — On-Demand Reports' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

// ---------------------------------------------------------------------------
// Route: POST /slack/actions  (button interactions)
// ---------------------------------------------------------------------------
async function handleSlackActions(request, env, ctx) {
  const rawBody = await request.text();

  const valid = await verifySlackSignature(rawBody, env.SLACK_SIGNING_SECRET, request);
  if (!valid) return new Response('Unauthorized', { status: 401 });

  const params  = new URLSearchParams(rawBody);
  const payload = JSON.parse(params.get('payload') ?? '{}');

  const actionId    = payload.actions?.[0]?.action_id ?? '';
  const responseUrl = payload.response_url ?? '';

  // ── Report generation buttons (report_7d / report_30d / report_90d) ─────
  const daysMap = { report_7d: 7, report_30d: 30, report_90d: 90 };
  const days    = daysMap[actionId];
  if (days) {
    ctx.waitUntil(
      (async () => {
        try {
          if (responseUrl) {
            await fetch(responseUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                response_type: 'ephemeral',
                replace_original: false,
                text: `Generating ${days}-day report — it will appear in the channel shortly.`,
              }),
            });
          }
          await handlePeriodSummary(env, days);
        } catch (err) {
          console.error(`[action ${actionId}]`, err.message);
          if (responseUrl) {
            await fetch(responseUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                response_type: 'ephemeral',
                replace_original: false,
                text: `Failed to generate ${days}-day report: ${err.message}`,
              }),
            }).catch(() => {});
          }
        }
      })()
    );
    return new Response('', { status: 200 });
  }

  // ── Drill-down buttons (expand_identity__ / expand_categories__ / etc.) ──
  // actionId format: "expand_<type>__<reportKey>"
  const drillMatch = actionId.match(/^expand_(identity|categories|actions|users)__(.+)$/);
  if (drillMatch) {
    const drillType = drillMatch[1];
    const reportKey = drillMatch[2];

    ctx.waitUntil(
      (async () => {
        try {
          // Load cached stats for this report from KV
          const raw = await env.VERIFY_BOT_STATE.get(`report_stats__${reportKey}`);
          if (!raw) {
            if (responseUrl) await fetch(responseUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ response_type: 'ephemeral', replace_original: false,
                text: 'Detail data has expired — please regenerate the report.' }),
            });
            return;
          }
          const stats = JSON.parse(raw);

          let blocks;
          let title;
          switch (drillType) {
            case 'identity':
              blocks = buildIdentityDrilldown(stats.byAction, stats.total);
              title  = 'Identity Lens — Full Breakdown';
              break;
            case 'categories':
              blocks = buildCategoryDrilldown(stats.byAction, stats.total);
              title  = 'All Activity Categories';
              break;
            case 'actions':
              blocks = buildActionsDrilldown(stats.byAction);
              title  = 'All Event Actions';
              break;
            case 'users':
              blocks = buildUsersDrilldown(stats.topUsers);
              title  = 'All Active Identities';
              break;
          }

          // Post as ephemeral reply via response_url
          if (responseUrl && blocks) {
            await fetch(responseUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                response_type: 'ephemeral',
                replace_original: false,
                text: title,
                blocks: [
                  { type: 'header', text: { type: 'plain_text', text: title, emoji: false } },
                  ...blocks,
                  { type: 'context', elements: [{ type: 'mrkdwn',
                    text: `_Only visible to you · Dismiss to close_` }] },
                ],
              }),
            });
          }
        } catch (err) {
          console.error(`[drill-down ${drillType}]`, err.message);
          if (responseUrl) await fetch(responseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response_type: 'ephemeral', replace_original: false,
              text: `Could not load drill-down: ${err.message}` }),
          }).catch(() => {});
        }
      })()
    );
    return new Response('', { status: 200 });
  }

  // Unknown action — ack with empty 200
  return new Response('', { status: 200 });
}

// ---------------------------------------------------------------------------
// Route: POST /slack/events
// ---------------------------------------------------------------------------
async function handleSlackEvents(request, env) {
  const rawBody = await request.text();

  const valid = await verifySlackSignature(rawBody, env.SLACK_SIGNING_SECRET, request);
  if (!valid) return new Response('Unauthorized', { status: 401 });

  const body = JSON.parse(rawBody);

  if (body.type === 'url_verification') {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('OK', { status: 200 });
}

// ---------------------------------------------------------------------------
// Cron handler: poll IBM Verify Events API every minute
// ---------------------------------------------------------------------------
async function handleScheduled(env) {
  const KV_KEY = 'lastPolledTime';

  // Read last poll time from KV; default to 2 minutes ago on first run
  let lastPolled = await env.VERIFY_BOT_STATE.get(KV_KEY);
  if (!lastPolled) {
    lastPolled = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  }

  let token;
  try {
    token = await getToken(eventsClientId(env), eventsClientSecret(env));
  } catch (err) {
    console.error('[POLL] token fetch failed:', err.message);
    return;
  }

  let events;
  try {
    events = await fetchEventsSince(lastPolled, token);
  } catch (err) {
    console.error('[POLL] events fetch failed:', err.message);
    return;
  }

  console.log(`[POLL] fetched ${events.length} events since ${lastPolled}`);

  // Save new poll time BEFORE processing so a crash doesn't re-process events
  await env.VERIFY_BOT_STATE.put(KV_KEY, new Date().toISOString());

  const threshold = parseInt(env.SEVERITY_THRESHOLD ?? '6', 10);

  for (const event of events) {
    try {
      const c = await classifyEvent(event, env.GEMINI_API_KEY);
      if (c.severity >= threshold) {
        const blocks = buildAlertBlock(event, c);
        await postToWebhook(env.SLACK_ALERT_WEBHOOK_URL, blocks, c.summary);
        console.log('[POLL ALERT]', event.data?.action, 'severity=' + c.severity);
      } else {
        console.log('[POLL SKIP]', event.data?.action, 'severity=' + c.severity);
      }
    } catch (err) {
      console.error('[POLL] classify/post error for event', event.id, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Use the dedicated events client if configured, fall back to the main client
function eventsClientId(env)     { return env.EVENTS_CLIENT_ID     || env.VERIFY_CLIENT_ID; }
function eventsClientSecret(env) { return env.EVENTS_CLIENT_SECRET || env.VERIFY_CLIENT_SECRET; }

/**
 * Tally a flat event array into the stats shape used by all summary builders.
 * @param {Array}  events
 * @param {number} threshold   severity floor for alert counting
 * @returns {{ total, successes, failures, alertsFired, byAction, topUsers, byHour }}
 */
function buildStats(events, threshold) {
  let successes = 0, failures = 0, alertsFired = 0;
  const byAction   = {};
  const userCounts = {};
  const byHour     = new Array(24).fill(0);  // SGT hour 0–23

  for (const event of events) {
    const action = event.data?.action ?? event.event_type ?? 'unknown';
    const result = (event.data?.result ?? '').toLowerCase();
    // Prefer human-readable username; label UUIDs as service accounts
    const rawUser = event.data?.username || event.data?.userid || event.data?.performedby || null;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const user = rawUser && UUID_RE.test(rawUser)
      ? `[svc] ${rawUser.slice(0, 8)}…`
      : rawUser;

    byAction[action] = (byAction[action] ?? 0) + 1;
    if (result === 'success') successes++;
    if (result === 'failure') failures++;
    if (user) userCounts[user] = (userCounts[user] ?? 0) + 1;

    // Bucket by SGT hour
    if (event.time) {
      const sgtHour = new Date(
        new Date(event.time).toLocaleString('en-US', { timeZone: 'Asia/Singapore' })
      ).getHours();
      byHour[sgtHour]++;
    }

    const fakeSeverity = result === 'failure' &&
      (action.includes('authn') || action.includes('login') || action.includes('authentication'))
      ? 7 : 0;
    if (fakeSeverity >= threshold) alertsFired++;
  }

  const topUsers = Object.entries(userCounts).sort((a, b) => b[1] - a[1]);
  return { total: events.length, successes, failures, alertsFired, byAction, topUsers, byHour };
}

/**
 * Pre-bucket byAction into category totals for Gemini — avoids sending 50+ raw actions.
 */
function bucketCategoriesForGemini(byAction) {
  const cats = {
    Authentication: 0, Token: 0, SSO: 0, MFA: 0,
    Management: 0, Provisioning: 0, 'Access Request': 0,
    Password: 0, Directory: 0, Uncategorised: 0,
  };
  for (const [action, count] of Object.entries(byAction)) {
    const a = action.toLowerCase();
    if      (a.includes('authentication') || a.includes('authn') || a.includes('login'))
                                                                              cats.Authentication    += count;
    else if (a.includes('token') || a.includes('issued') || a.includes('revoked') || a.includes('grant') || a.includes('introspect'))
                                                                              cats.Token             += count;
    else if (a.includes('sso')            || a.includes('saml')   || a.includes('oidc'))
                                                                              cats.SSO               += count;
    else if (a.includes('mfa')            || a.includes('factor') || a.includes('enroll'))
                                                                              cats.MFA               += count;
    else if (a.includes('password')       || a.includes('credential') || a.includes('reset'))
                                                                              cats.Password          += count;
    else if (a.includes('provision')      || a.includes('scim')   || a.includes('sync'))
                                                                              cats.Provisioning      += count;
    else if (a.includes('management')     || a.includes('lifecycle') || a.includes('admin') || a.includes('create') || a.includes('delet') || a.includes('modif'))
                                                                              cats.Management        += count;
    else if (a.includes('access_request') || a.includes('access request') || a.includes('approval'))
                                                                              cats['Access Request'] += count;
    else if (a.includes('report')         || a.includes('directory') || a.includes('consent'))
                                                                              cats.Directory         += count;
    else cats.Uncategorised += count;
  }
  return Object.fromEntries(Object.entries(cats).filter(([, v]) => v > 0));
}

// ---------------------------------------------------------------------------
// Daily summary handler — runs at 08:00 SGT (cron 0 0 * * *)
// ---------------------------------------------------------------------------
async function handleDailySummary(env) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  console.log('[SUMMARY] starting — fetching events since', since);

  const token = await getToken(eventsClientId(env), eventsClientSecret(env));
  const events = await fetchEventsSince(since, token);
  console.log(`[SUMMARY] fetched ${events.length} events`);

  const threshold = parseInt(env.SEVERITY_THRESHOLD ?? '6', 10);
  const stats = buildStats(events, threshold);
  console.log('[SUMMARY] stats:', JSON.stringify({ total: stats.total, successes: stats.successes, failures: stats.failures }));

  const now = new Date();
  const dateLabel = now.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore',
  });

  // All Gemini calls in parallel — 1 narrative + 3 section commentaries
  const cats    = bucketCategoriesForGemini(stats.byAction);
  const topActs = Object.fromEntries(Object.entries(stats.byAction).sort((a, b) => b[1] - a[1]).slice(0, 6));
  const topUsrs = Object.fromEntries(stats.topUsers?.slice(0, 5) ?? []);

  const [narrative, catNote, actNote, usrNote] = await Promise.all([
    generateDailySummary(stats, env.GEMINI_API_KEY).catch(() =>
      `${stats.total} events recorded today. ${stats.failures} failures.`),
    generateSectionCommentary('categories', cats,    1, env.GEMINI_API_KEY),
    generateSectionCommentary('actions',    topActs, 1, env.GEMINI_API_KEY),
    generateSectionCommentary('users',      topUsrs, 1, env.GEMINI_API_KEY),
  ]);
  console.log('[SUMMARY] Gemini narrative + commentary OK');

  // Cache stats in KV so drill-down buttons can retrieve them (TTL 24h)
  const dailyKey = `daily__${Date.now()}`;
  await env.VERIFY_BOT_STATE.put(
    `report_stats__${dailyKey}`,
    JSON.stringify({ total: stats.total, byAction: stats.byAction, topUsers: stats.topUsers }),
    { expirationTtl: 86400 },
  );

  const commentary = { categories: catNote, actions: actNote, users: usrNote };
  const blocks = buildDailySummaryBlock(dateLabel, stats, narrative, commentary, dailyKey);
  const slackStatus = await postToWebhook(env.SLACK_ALERT_WEBHOOK_URL, blocks, `Daily IBM Verify Summary — ${dateLabel}`);
  console.log('[SUMMARY] Slack webhook status:', slackStatus);
  if (slackStatus !== 200) throw new Error(`Slack webhook returned HTTP ${slackStatus}`);
  console.log('[SUMMARY] done ✓');
}

// ---------------------------------------------------------------------------
// Period summary handler — 7, 30, or 90-day window
// ---------------------------------------------------------------------------
async function handlePeriodSummary(env, days) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - days * msPerDay).toISOString();
  console.log(`[PERIOD-${days}d] fetching events since`, since);

  const token = await getToken(eventsClientId(env), eventsClientSecret(env));
  const events = await fetchEventsSince(since, token);
  console.log(`[PERIOD-${days}d] fetched ${events.length} events over ${days} days`);

  const threshold = parseInt(env.SEVERITY_THRESHOLD ?? '6', 10);
  const stats = buildStats(events, threshold);

  // Date range label — "1 Oct – 7 Oct 2026 SGT"
  const fmtOpts  = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' };
  const nowLabel  = new Date().toLocaleDateString('en-GB', fmtOpts);
  const thenLabel = new Date(Date.now() - days * msPerDay).toLocaleDateString('en-GB', fmtOpts);
  const dateRange = `${thenLabel} – ${nowLabel}`;

  const cats    = bucketCategoriesForGemini(stats.byAction);
  const topActs = Object.fromEntries(Object.entries(stats.byAction).sort((a, b) => b[1] - a[1]).slice(0, 8));
  const topUsrs = Object.fromEntries(stats.topUsers?.slice(0, 5) ?? []);
  const avg     = Math.round(stats.total / days);
  const fallbackInsights = `${stats.total.toLocaleString()} events over ${days} days (~${avg}/day). Failure rate: ${stats.total > 0 ? ((stats.failures / stats.total) * 100).toFixed(1) : 0}%.`;

  const [insights, catNote, actNote, usrNote] = await Promise.all([
    generatePeriodInsights(stats, days, env.GEMINI_API_KEY).catch(() => fallbackInsights),
    generateSectionCommentary('categories', cats,    days, env.GEMINI_API_KEY),
    generateSectionCommentary('actions',    topActs, days, env.GEMINI_API_KEY),
    generateSectionCommentary('users',      topUsrs, days, env.GEMINI_API_KEY),
  ]);
  console.log(`[PERIOD-${days}d] Gemini insights + commentary OK`);

  // Cache stats in KV for drill-down buttons (TTL 7 days)
  const periodKey = `period${days}__${Date.now()}`;
  await env.VERIFY_BOT_STATE.put(
    `report_stats__${periodKey}`,
    JSON.stringify({ total: stats.total, byAction: stats.byAction, topUsers: stats.topUsers }),
    { expirationTtl: 604800 },
  );

  const commentary = { categories: catNote, actions: actNote, users: usrNote };
  const blocks = buildPeriodSummaryBlock(days, dateRange, stats, insights, commentary, periodKey);
  const slackStatus = await postToWebhook(
    env.SLACK_ALERT_WEBHOOK_URL, blocks,
    `IBM Verify ${days}-Day Report  ·  ${dateRange}`
  );
  console.log(`[PERIOD-${days}d] Slack status:`, slackStatus);
  if (slackStatus !== 200) throw new Error(`Slack webhook returned HTTP ${slackStatus}`);
  console.log(`[PERIOD-${days}d] done ✓`);
}

// ---------------------------------------------------------------------------
// Main fetch + scheduled handlers
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/verify-webhook':
        return handleVerifyWebhook(request, env, ctx);
      case '/slack/command':
        return handleSlashCommand(request, env, ctx);
      case '/slack/actions':
        return handleSlackActions(request, env, ctx);
      case '/slack/events':
        return handleSlackEvents(request, env);
      case '/health':
        return new Response(JSON.stringify({ status: 'ok', worker: 'verify-bot' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      // Manual trigger for summaries — ?days=1|7|30|90 (default 1)
      // Protected by VERIFY_WEBHOOK_SECRET header
      case '/trigger-summary': {
        if (request.headers.get('X-Verify-Secret') !== env.VERIFY_WEBHOOK_SECRET) {
          return new Response('Unauthorized', { status: 401 });
        }
        const daysParam = parseInt(new URL(request.url).searchParams.get('days') ?? '1', 10);
        const days = [1, 7, 30, 90].includes(daysParam) ? daysParam : 1;
        try {
          if (days === 1) {
            await handleDailySummary(env);
          } else {
            await handlePeriodSummary(env, days);
          }
          return new Response(
            JSON.stringify({ status: 'ok', message: `${days}-day summary posted to Slack`, days }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        } catch (err) {
          console.error(`[trigger-summary days=${days}] failed:`, err.message);
          return new Response(
            JSON.stringify({ status: 'error', error: err.message, days }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }
      default:
        return new Response('Not found', { status: 404 });
    }
  },

  async scheduled(event, env, _ctx) {
    // Dispatch by cron expression
    switch (event.cron) {
      case '0 0 * * *':  await handleDailySummary(env);        break;  // 08:00 SGT daily
      case '0 0 * * 1':  await handlePeriodSummary(env, 7);    break;  // 08:00 SGT Monday (weekly)
      case '0 0 1 * *':  await handlePeriodSummary(env, 30);   break;  // 08:00 SGT 1st of month
      case '0 0 1 */3 *': await handlePeriodSummary(env, 90);  break;  // 08:00 SGT quarterly
      default:            await handleScheduled(env);           break;  // every minute — poll
    }
  },
};
