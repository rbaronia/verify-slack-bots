// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------
function severityLabel(s) {
  if (s >= 9) return 'CRITICAL';
  if (s >= 7) return 'HIGH';
  if (s >= 5) return 'MEDIUM';
  if (s >= 3) return 'LOW';
  return 'INFO';
}

function severityPrefix(s) {
  if (s >= 9) return '[CRITICAL]';
  if (s >= 7) return '[HIGH]';
  if (s >= 5) return '[MEDIUM]';
  if (s >= 3) return '[LOW]';
  return '[INFO]';
}

/** Format ISO time as "7 Oct 2026, 12:54 SGT" */
function toSGT(isoTime) {
  if (!isoTime) return '—';
  return new Date(isoTime).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Singapore', timeZoneName: 'short',
  });
}

/** Normalise an IBM Verify action string into a short readable label.
 *
 * Examples:
 *   "user.authentication.login"  → "Login"
 *   "token.issued"               → "Token Issued"
 *   "token.introspect"           → "Token Introspect"
 *   "user.lifecycle.create"      → "User Created"
 *   "sso.saml.login"             → "SSO Login"
 */
function prettifyAction(action) {
  const STRIP_MIDDLE  = new Set(['authentication', 'lifecycle']);
  const STRIP_LEADING = new Set(['user', 'users', 'application', 'app', 'group', 'groups', 'system']);

  let parts = action.split(/[._]/).filter(Boolean);
  parts = parts.filter(w => !STRIP_MIDDLE.has(w.toLowerCase()));
  if (parts.length > 1 && STRIP_LEADING.has(parts[0].toLowerCase())) parts = parts.slice(1);
  parts = parts.filter((w, i) => i === 0 || w.toLowerCase() !== parts[i - 1].toLowerCase());

  const PAST = { create: 'Created', delet: 'Deleted', modif: 'Modified', updat: 'Updated' };
  parts = parts.map(w => {
    const lw = w.toLowerCase();
    for (const [stem, label] of Object.entries(PAST)) if (lw.startsWith(stem)) return label;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Visual helpers
// ---------------------------------------------------------------------------

/** Inline mrkdwn horizontal bar — plain Unicode, no backticks. width=10 default. */
function inlineBar(count, maxCount, width = 10) {
  if (maxCount === 0) return '░'.repeat(width);
  const filled = Math.round((count / maxCount) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Vertical bar chart — 24 cols × 6 rows, SGT x-axis */
function buildHourlyChart(byHour) {
  if (!byHour || byHour.every(v => v === 0)) return 'No activity data.';
  const maxVal = Math.max(...byHour);
  const ROWS   = 6;
  const grid   = [];
  for (let r = 0; r < ROWS; r++) {
    const threshold = ((ROWS - r) / ROWS) * maxVal;
    let row = '';
    for (let h = 0; h < 24; h++) row += byHour[h] >= threshold ? '█' : ' ';
    if (r === 0)        row += `  ${maxVal}`;
    if (r === ROWS - 1) row += '  0';
    grid.push(row);
  }
  return grid.join('\n') + '\n├' + '─'.repeat(23) + '┤\n0    6    12   18  23  (SGT)';
}

// ---------------------------------------------------------------------------
// Category & identity classification
// ---------------------------------------------------------------------------

/**
 * Colour dot per category for visual differentiation in Slack plain text.
 * Slack mrkdwn doesn't support colour in text — dots are the practical solution.
 */
const CAT_DOT = {
  Authentication:   '🟢',
  Token:            '🔵',
  SSO:              '🟣',
  MFA:              '🟠',
  Management:       '🟡',
  Provisioning:     '🔶',
  'Access Request': '🔷',
  Password:         '🔴',
  Directory:        '⚪',
  Uncategorised:    '⬜',
};

/**
 * Classify a single action string as Human or NHI (Non-Human Identity).
 * NHI = automated/machine interactions: tokens, introspection, provisioning, SCIM.
 * Human = login, auth, SSO, MFA, password, access requests, user management.
 */
function isNHI(action) {
  const a = action.toLowerCase();
  return (
    a.includes('token')    || a.includes('issued')    || a.includes('revoked')  ||
    a.includes('grant')    || a.includes('introspect') || a.includes('provision') ||
    a.includes('scim')     || a.includes('sync')       || a.includes('api')
  );
}

/**
 * Full category bucketing — returns both the category map and the action→category index.
 * The index is used for action-line colouring.
 */
function bucketByCategory(byAction) {
  const cats = {
    Authentication: 0, Token: 0, SSO: 0, MFA: 0,
    Management: 0, Provisioning: 0, 'Access Request': 0,
    Password: 0, Directory: 0, Uncategorised: 0,
  };
  const actionCat = {};   // action → category name

  for (const [action, count] of Object.entries(byAction)) {
    const a = action.toLowerCase();
    let cat;
    if      (a.includes('authentication') || a.includes('authn') || a.includes('login'))
      cat = 'Authentication';
    else if (a.includes('token') || a.includes('issued') || a.includes('revoked') || a.includes('grant') || a.includes('introspect'))
      cat = 'Token';
    else if (a.includes('sso') || a.includes('saml') || a.includes('oidc'))
      cat = 'SSO';
    else if (a.includes('mfa') || a.includes('factor') || a.includes('enroll'))
      cat = 'MFA';
    else if (a.includes('password') || a.includes('credential') || a.includes('reset'))
      cat = 'Password';
    else if (a.includes('provision') || a.includes('scim') || a.includes('sync'))
      cat = 'Provisioning';
    else if (a.includes('management') || a.includes('lifecycle') || a.includes('admin') || a.includes('create') || a.includes('delet') || a.includes('modif'))
      cat = 'Management';
    else if (a.includes('access_request') || a.includes('access request') || a.includes('approval'))
      cat = 'Access Request';
    else if (a.includes('report') || a.includes('directory') || a.includes('consent'))
      cat = 'Directory';
    else
      cat = 'Uncategorised';

    cats[cat] += count;
    actionCat[action] = cat;
  }
  return { cats, actionCat };
}

/**
 * Split event totals into Human Identity vs Non-Human Identity (NHI).
 * Returns subcategory breakdowns for each lane.
 */
function splitIdentityLens(byAction) {
  // Human subcategories
  const humanSubs = { Authentication: 0, SSO: 0, MFA: 0, Password: 0, 'Access Request': 0 };
  // NHI subcategories
  const nhiSubs   = { 'Token Issued': 0, 'Token Revoked': 0, 'Token Introspect': 0, Provisioning: 0, 'API/Grant': 0 };

  let humanTotal = 0;
  let nhiTotal   = 0;

  for (const [action, count] of Object.entries(byAction)) {
    const a = action.toLowerCase();
    if (isNHI(action)) {
      nhiTotal += count;
      if      (a.includes('issued'))     nhiSubs['Token Issued']     += count;
      else if (a.includes('revoked'))    nhiSubs['Token Revoked']    += count;
      else if (a.includes('introspect')) nhiSubs['Token Introspect'] += count;
      else if (a.includes('provision') || a.includes('scim') || a.includes('sync'))
        nhiSubs.Provisioning += count;
      else                               nhiSubs['API/Grant']        += count;
    } else {
      humanTotal += count;
      if      (a.includes('authentication') || a.includes('authn') || a.includes('login'))
        humanSubs.Authentication += count;
      else if (a.includes('sso') || a.includes('saml') || a.includes('oidc'))
        humanSubs.SSO += count;
      else if (a.includes('mfa') || a.includes('factor') || a.includes('enroll'))
        humanSubs.MFA += count;
      else if (a.includes('password') || a.includes('credential') || a.includes('reset'))
        humanSubs.Password += count;
      else if (a.includes('access_request') || a.includes('approval'))
        humanSubs['Access Request'] += count;
    }
  }
  return { humanTotal, nhiTotal, humanSubs, nhiSubs };
}

// ---------------------------------------------------------------------------
// Section builders — compact visual + optional detail expansion
// ---------------------------------------------------------------------------

/**
 * Identity Lens section — compact two-line summary + drill-down button.
 * Shows Human vs NHI totals with bars and percentage.
 */
function buildIdentityLensSection(byAction, total, reportKey) {
  const { humanTotal, nhiTotal } = splitIdentityLens(byAction);
  const maxVal   = Math.max(humanTotal, nhiTotal, 1);
  const humanPct = total > 0 ? Math.round((humanTotal / total) * 100) : 0;
  const nhiPct   = total > 0 ? Math.round((nhiTotal   / total) * 100) : 0;

  const humanBar = inlineBar(humanTotal, maxVal, 10);
  const nhiBar   = inlineBar(nhiTotal,   maxVal, 10);

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*Identity Lens*\n` +
          `👤 *Human*   ${humanBar}  ${humanTotal.toLocaleString()}  _(${humanPct}%)_\n` +
          `🤖 *NHI*     ${nhiBar}  ${nhiTotal.toLocaleString()}  _(${nhiPct}%)_`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Breakdown', emoji: false },
        action_id: `expand_identity__${reportKey}`,
        value: reportKey,
      },
    },
  ];
}

/**
 * Category section — top 4 categories with coloured dots + bars, drill-down button.
 */
function buildCategorySection(byAction, total, commentary, reportKey) {
  const { cats } = bucketByCategory(byAction);
  const entries  = Object.entries(cats).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const top4     = entries.slice(0, 4);
  const maxVal   = top4.length ? top4[0][1] : 1;

  const lines = top4.map(([cat, count]) => {
    const pct  = total > 0 ? Math.round((count / total) * 100) : 0;
    const bar  = inlineBar(count, maxVal, 10);
    const dot  = CAT_DOT[cat] ?? '⬜';
    return `${dot} *${cat}*  ${bar}  ${count.toLocaleString()}  _(${pct}%)_`;
  }).join('\n');

  const moreCount = entries.length - 4;
  const moreNote  = moreCount > 0 ? `\n_+ ${moreCount} more categories_` : '';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Activity by Category*\n${lines || '_No events_'}${moreNote}`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'All categories', emoji: false },
        action_id: `expand_categories__${reportKey}`,
        value: reportKey,
      },
    },
  ];

  if (commentary) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_${commentary}_` }],
    });
  }
  return blocks;
}

/**
 * Top actions section — top 5 with category dot, drill-down button.
 */
function buildActionsSection(byAction, commentary, reportKey) {
  const { actionCat } = bucketByCategory(byAction);
  const sorted  = Object.entries(byAction).sort((a, b) => b[1] - a[1]);
  const top5    = sorted.slice(0, 5);
  const moreCount = sorted.length - 5;

  const lines = top5.map(([action, count], i) => {
    const dot  = CAT_DOT[actionCat[action]] ?? '⬜';
    const tag  = isNHI(action) ? ' _🤖_' : ' _👤_';
    return `${i + 1}. ${dot}${tag} *${prettifyAction(action)}* — ${count.toLocaleString()}`;
  }).join('\n');

  const moreNote = moreCount > 0 ? `\n_+ ${moreCount} more actions_` : '';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Top Event Actions*\n${lines || '_none_'}${moreNote}`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'All actions', emoji: false },
        action_id: `expand_actions__${reportKey}`,
        value: reportKey,
      },
    },
  ];

  if (commentary) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_${commentary}_` }],
    });
  }
  return blocks;
}

/**
 * Active users section — top 3 human + top 2 NHI side-by-side, drill-down button.
 */
function buildUsersSection(topUsers, commentary, reportKey) {
  if (!topUsers?.length) {
    return [{
      type: 'section',
      text: { type: 'mrkdwn', text: '*Most Active Users*\n_No user data_' },
    }];
  }

  // Split into human vs NHI (service accounts)
  const humans = topUsers.filter(([u]) => !u.startsWith('[svc]'));
  const svcs   = topUsers.filter(([u]) =>  u.startsWith('[svc]'));

  const humanLines = humans.slice(0, 3)
    .map(([u, c], i) => `${i + 1}. 👤 *${u}* — ${c.toLocaleString()}`)
    .join('\n') || '_None_';

  const svcLines = svcs.slice(0, 3)
    .map(([u, c], i) => `${i + 1}. 🤖 *${u}* — ${c.toLocaleString()}`)
    .join('\n') || '_None_';

  const moreCount = topUsers.length - 5;

  const blocks = [
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Human Identities*\n${humanLines}` },
        { type: 'mrkdwn', text: `*Service Accounts (NHI)*\n${svcLines}` },
      ],
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'All users', emoji: false },
        action_id: `expand_users__${reportKey}`,
        value: reportKey,
      },
    },
  ];

  if (moreCount > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_+ ${moreCount} more identities_` }],
    });
  }
  if (commentary) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_${commentary}_` }],
    });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Drill-down ephemeral payloads — full detail tables
// ---------------------------------------------------------------------------

/** Full identity lens breakdown — Human subcats + NHI subcats */
export function buildIdentityDrilldown(byAction, total) {
  const { humanTotal, nhiTotal, humanSubs, nhiSubs } = splitIdentityLens(byAction);
  const maxH = Math.max(...Object.values(humanSubs), 1);
  const maxN = Math.max(...Object.values(nhiSubs), 1);

  const humanLines = Object.entries(humanSubs)
    .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .map(([sub, count]) => {
      const pct = humanTotal > 0 ? Math.round((count / humanTotal) * 100) : 0;
      return `👤 ${inlineBar(count, maxH, 8)}  *${sub}*  ${count.toLocaleString()}  _(${pct}%)_`;
    }).join('\n') || '_No data_';

  const nhiLines = Object.entries(nhiSubs)
    .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .map(([sub, count]) => {
      const pct = nhiTotal > 0 ? Math.round((count / nhiTotal) * 100) : 0;
      return `🤖 ${inlineBar(count, maxN, 8)}  *${sub}*  ${count.toLocaleString()}  _(${pct}%)_`;
    }).join('\n') || '_No data_';

  return [
    { type: 'section', text: { type: 'mrkdwn',
      text: `*Identity Breakdown — Human* (${humanTotal.toLocaleString()} total, ${total > 0 ? Math.round(humanTotal/total*100) : 0}%)\n${humanLines}` } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn',
      text: `*Identity Breakdown — Non-Human (NHI)* (${nhiTotal.toLocaleString()} total, ${total > 0 ? Math.round(nhiTotal/total*100) : 0}%)\n${nhiLines}` } },
  ];
}

/** Full category breakdown — all categories with coloured dots */
export function buildCategoryDrilldown(byAction, total) {
  const { cats } = bucketByCategory(byAction);
  const entries  = Object.entries(cats).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const maxVal   = entries.length ? entries[0][1] : 1;

  const lines = entries.map(([cat, count]) => {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const dot = CAT_DOT[cat] ?? '⬜';
    return `${dot} ${inlineBar(count, maxVal, 10)}  *${cat}*  ${count.toLocaleString()}  _(${pct}%)_`;
  }).join('\n');

  return [{
    type: 'section',
    text: { type: 'mrkdwn', text: `*All Activity Categories*\n${lines || '_No events_'}` },
  }];
}

/** Full actions breakdown — all actions with category dot + NHI/Human tag */
export function buildActionsDrilldown(byAction) {
  const { actionCat } = bucketByCategory(byAction);
  const sorted  = Object.entries(byAction).sort((a, b) => b[1] - a[1]);
  const maxVal  = sorted.length ? sorted[0][1] : 1;

  // Group by category for the detail view
  const byCat = {};
  for (const [action, count] of sorted) {
    const cat = actionCat[action] ?? 'Uncategorised';
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push([action, count]);
  }

  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '*All Event Actions — by Category*' } }];

  for (const [cat, entries] of Object.entries(byCat)) {
    const dot   = CAT_DOT[cat] ?? '⬜';
    const lines = entries.map(([action, count]) => {
      const tag = isNHI(action) ? '🤖' : '👤';
      return `  ${tag} *${prettifyAction(action)}* — ${count.toLocaleString()}  ${inlineBar(count, maxVal, 6)}`;
    }).join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${dot} *${cat}*\n${lines}` } });
  }
  return blocks;
}

/** Full users breakdown — all users split Human/NHI */
export function buildUsersDrilldown(topUsers) {
  if (!topUsers?.length) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: '*All Active Identities*\n_No user data_' } }];
  }

  const humans = topUsers.filter(([u]) => !u.startsWith('[svc]'));
  const svcs   = topUsers.filter(([u]) =>  u.startsWith('[svc]'));
  const maxH   = humans.length ? humans[0][1] : 1;
  const maxS   = svcs.length   ? svcs[0][1]   : 1;

  const humanLines = humans.map(([u, c], i) =>
    `${i + 1}. ${inlineBar(c, maxH, 8)}  *${u}* — ${c.toLocaleString()}`
  ).join('\n') || '_None_';

  const svcLines = svcs.map(([u, c], i) =>
    `${i + 1}. ${inlineBar(c, maxS, 8)}  *${u}* — ${c.toLocaleString()}`
  ).join('\n') || '_None_';

  return [
    { type: 'section', text: { type: 'mrkdwn',
      text: `*Human Identities (${humans.length})*\n${humanLines}` } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn',
      text: `*Service Accounts / NHI (${svcs.length})*\n${svcLines}` } },
  ];
}

// ---------------------------------------------------------------------------
// Shared: report picker buttons
// ---------------------------------------------------------------------------
function reportPickerBlocks(label) {
  return [
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `*${label}*` } },
    {
      type: 'actions',
      block_id: 'report_picker',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Last 7 Days',  emoji: false }, value: '7',  action_id: 'report_7d',  style: 'primary' },
        { type: 'button', text: { type: 'plain_text', text: 'Last 30 Days', emoji: false }, value: '30', action_id: 'report_30d' },
        { type: 'button', text: { type: 'plain_text', text: 'Last 90 Days', emoji: false }, value: '90', action_id: 'report_90d' },
      ],
    },
  ];
}

export function buildReportControlPanel() {
  return [
    { type: 'section', text: { type: 'mrkdwn',
      text: '*IBM Verify — On-Demand Reports*\nSelect a window to generate an activity report.' } },
    {
      type: 'actions',
      block_id: 'report_picker',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Last 7 Days',  emoji: false }, value: '7',  action_id: 'report_7d',  style: 'primary' },
        { type: 'button', text: { type: 'plain_text', text: 'Last 30 Days', emoji: false }, value: '30', action_id: 'report_30d' },
        { type: 'button', text: { type: 'plain_text', text: 'Last 90 Days', emoji: false }, value: '90', action_id: 'report_90d' },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Alert block — real-time event card
// ---------------------------------------------------------------------------
export function buildAlertBlock(event, c) {
  const d        = event.data ?? {};
  const label    = severityLabel(c.severity);
  const prefix   = severityPrefix(c.severity);
  const action   = d.action ?? 'unknown';
  const result   = d.result ?? '';
  const resultTx = result === 'success' ? 'Success' : result === 'failure' ? 'Failure' : result || '—';
  const username = d.username || d.userid    || '—';
  const app      = d.applicationname         || '—';
  const ip       = d.origin   || d.ipAddress || '—';
  const subtype  = d.subtype                 || '—';
  const cause    = d.cause                   || '—';
  const target   = d.target?.value || (typeof d.target === 'string' ? d.target : null);
  const sgtTime  = toSGT(event.time);
  const identityTag = isNHI(action) ? '🤖 NHI' : '👤 Human';

  return [
    { type: 'header',
      text: { type: 'plain_text', text: `${prefix}  ${prettifyAction(action)}`, emoji: false } },
    { type: 'section',
      text: { type: 'mrkdwn',
        text: `> ${c.summary}\n_Severity: *${label}* (${c.severity}/10)  ·  ${identityTag}  ·  ${sgtTime}_` } },
    { type: 'divider' },
    { type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*User*\n${username}` },
        { type: 'mrkdwn', text: `*Result*\n${resultTx}` },
        { type: 'mrkdwn', text: `*Application*\n${app}` },
        { type: 'mrkdwn', text: `*Source IP*\n\`${ip}\`` },
      ] },
    { type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Auth Method*\n\`${subtype}\`` },
        { type: 'mrkdwn', text: `*Cause*\n${cause}` },
        ...(target ? [{ type: 'mrkdwn', text: `*Target*\n${target}` }] : []),
      ] },
    { type: 'context',
      elements: [
        { type: 'mrkdwn', text: `_${c.rationale}_` },
        { type: 'mrkdwn', text: `IBM Verify SaaS · baronia` },
      ] },
  ];
}

// ---------------------------------------------------------------------------
// Daily digest — 24-hour scheduled summary
// commentary = { categories: string, actions: string, users: string }
// ---------------------------------------------------------------------------
export function buildDailySummaryBlock(dateLabel, stats, narrative, commentary = {}, reportKey) {
  const successRate = stats.total > 0 ? Math.round((stats.successes / stats.total) * 100) : 100;
  const failRate    = stats.total > 0 ? ((stats.failures / stats.total) * 100).toFixed(1) : '0.0';
  const alertPct    = stats.total > 0 ? Math.round((stats.alertsFired / stats.total) * 100) : 0;

  const healthLabel = stats.failures === 0 ? 'Healthy'
                    : stats.failures < 5   ? 'Warning'
                    : stats.failures < 20  ? 'Elevated'
                    :                        'Critical';
  const healthDot   = stats.failures === 0 ? '🟢' : stats.failures < 5 ? '🟡' : stats.failures < 20 ? '🟠' : '🔴';
  const healthDisplay = `${healthDot} ${healthLabel}  ·  ${stats.failures === 0 ? '0 failures' : `${stats.failures} failure${stats.failures !== 1 ? 's' : ''}`}`;

  const REPORT_KEY = reportKey ?? `daily__${Date.now()}`;
  const generatedAt = new Date().toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Singapore', timeZoneName: 'short',
  });

  return [
    // ── Header ──────────────────────────────────────────────────────────────
    { type: 'header',
      text: { type: 'plain_text', text: `Daily IBM Verify Digest  ·  ${dateLabel}`, emoji: false } },

    // ── AI narrative ─────────────────────────────────────────────────────────
    { type: 'section',
      text: { type: 'mrkdwn',
        text: narrative.length > 80
          ? `> ${narrative.trim().split('\n').join('\n> ')}`
          : `_${narrative.trim()}_` } },

    { type: 'divider' },

    // ── KPI scorecard ────────────────────────────────────────────────────────
    { type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Health*\n${healthDisplay}` },
        { type: 'mrkdwn', text: `*Total Events*\n${stats.total.toLocaleString()}` },
        { type: 'mrkdwn', text: `*Failures*\n${stats.failures.toLocaleString()}  (${failRate}%)` },
        { type: 'mrkdwn', text: `*Alerts Fired*\n${stats.alertsFired}  (${alertPct}%)` },
        { type: 'mrkdwn', text: `*Success Rate*\n${successRate}%` },
        { type: 'mrkdwn', text: `*Successes*\n${stats.successes.toLocaleString()}` },
      ] },

    { type: 'divider' },

    // ── Identity Lens ────────────────────────────────────────────────────────
    ...buildIdentityLensSection(stats.byAction, stats.total, REPORT_KEY),

    { type: 'divider' },

    // ── Activity by Category (top 4 + button) ────────────────────────────────
    ...buildCategorySection(stats.byAction, stats.total, commentary.categories, REPORT_KEY),

    { type: 'divider' },

    // ── Top Event Actions (top 5 + button) ───────────────────────────────────
    ...buildActionsSection(stats.byAction, commentary.actions, REPORT_KEY),

    { type: 'divider' },

    // ── Most Active Users (3 human + 2 NHI + button) ─────────────────────────
    ...buildUsersSection(stats.topUsers, commentary.users, REPORT_KEY),

    { type: 'divider' },

    // ── Hourly chart ─────────────────────────────────────────────────────────
    { type: 'section',
      text: { type: 'mrkdwn',
        text: `*Hourly Activity (SGT)*\n\`\`\`\n${buildHourlyChart(stats.byHour)}\n\`\`\`` } },

    // ── Report picker ────────────────────────────────────────────────────────
    ...reportPickerBlocks('Go deeper — pull a longer report:'),

    // ── Footer ────────────────────────────────────────────────────────────────
    { type: 'context',
      elements: [{ type: 'mrkdwn',
        text: `IBM Verify SaaS · baronia tenant · Generated ${generatedAt} · Next digest in 24 h` }] },
  ];
}

// ---------------------------------------------------------------------------
// Period summary — 7 / 30 / 90 day report
// commentary = { categories: string, actions: string, users: string }
// ---------------------------------------------------------------------------
export function buildPeriodSummaryBlock(days, dateRange, stats, insights, commentary = {}, reportKey) {
  const periodLabel = `Last ${days} Days`;
  const avgPerDay   = Math.round(stats.total / days);
  const successRate = stats.total > 0 ? Math.round((stats.successes / stats.total) * 100) : 100;
  const failRate    = stats.total > 0 ? ((stats.failures / stats.total) * 100).toFixed(1) : '0.0';

  const healthLabel = stats.failures === 0 ? 'Healthy'
                    : stats.failures < 10  ? 'Warning'
                    : stats.failures < 50  ? 'Elevated'
                    :                        'Critical';
  const healthDot   = stats.failures === 0 ? '🟢' : stats.failures < 10 ? '🟡' : stats.failures < 50 ? '🟠' : '🔴';
  const healthDisplay = `${healthDot} ${healthLabel}  ·  ${stats.failures === 0 ? '0 failures' : `${stats.failures.toLocaleString()} failure${stats.failures !== 1 ? 's' : ''}`}`;

  const REPORT_KEY = reportKey ?? `period${days}__${Date.now()}`;
  const generatedAt = new Date().toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Singapore', timeZoneName: 'short',
  });

  return [
    // ── Header ──────────────────────────────────────────────────────────────
    { type: 'header',
      text: { type: 'plain_text',
        text: `IBM Verify  ·  ${periodLabel}  ·  ${dateRange}`, emoji: false } },

    // ── Gemini insights ──────────────────────────────────────────────────────
    { type: 'section',
      text: { type: 'mrkdwn',
        text: insights.length > 80
          ? `> ${insights.trim().split('\n').join('\n> ')}`
          : `_${insights.trim()}_` } },

    { type: 'divider' },

    // ── KPI scorecard ────────────────────────────────────────────────────────
    { type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Health*\n${healthDisplay}` },
        { type: 'mrkdwn', text: `*Total Events*\n${stats.total.toLocaleString()}` },
        { type: 'mrkdwn', text: `*Failures*\n${stats.failures.toLocaleString()}  (${failRate}%)` },
        { type: 'mrkdwn', text: `*Alerts Fired*\n${stats.alertsFired}` },
        { type: 'mrkdwn', text: `*Avg / Day*\n${avgPerDay.toLocaleString()}` },
        { type: 'mrkdwn', text: `*Success Rate*\n${successRate}%` },
      ] },

    { type: 'divider' },

    // ── Identity Lens ────────────────────────────────────────────────────────
    ...buildIdentityLensSection(stats.byAction, stats.total, REPORT_KEY),

    { type: 'divider' },

    // ── Activity by Category (top 4 + button) ────────────────────────────────
    ...buildCategorySection(stats.byAction, stats.total, commentary.categories, REPORT_KEY),

    { type: 'divider' },

    // ── Top Event Actions (top 5 + button) ───────────────────────────────────
    ...buildActionsSection(stats.byAction, commentary.actions, REPORT_KEY),

    { type: 'divider' },

    // ── Most Active Users (3 human + 2 NHI + button) ─────────────────────────
    ...buildUsersSection(stats.topUsers, commentary.users, REPORT_KEY),

    // ── Report picker ────────────────────────────────────────────────────────
    ...reportPickerBlocks('Pull another report:'),

    // ── Footer ────────────────────────────────────────────────────────────────
    { type: 'context',
      elements: [{ type: 'mrkdwn',
        text: `IBM Verify SaaS · baronia tenant · ${periodLabel} ending ${dateRange} · Generated ${generatedAt}` }] },
  ];
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------
export async function postToWebhook(webhookUrl, blocks, fallbackText) {
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: fallbackText, blocks }),
  });
  return resp.status;
}

export async function postToResponseUrl(responseUrl, text, blocks) {
  const body = blocks
    ? { response_type: 'in_channel', replace_original: false, text, blocks }
    : { response_type: 'in_channel', replace_original: true, text };
  const resp = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.status;
}
