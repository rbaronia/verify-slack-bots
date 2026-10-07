const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';

const ALLOWED_TOOLS = [
  'ibm_verify_get_user_count',
  'ibm_verify_get_group_count',
  'ibm_verify_list_users',
  'ibm_verify_get_user',
  'ibm_verify_list_groups',
  'ibm_verify_list_user_mfa_enrollments',
  'ibm_verify_list_applications',
  'ibm_verify_list_all_mfa_enrollments',
];

function extractJson(text) {
  // Strip markdown fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  return JSON.parse(raw.trim());
}

async function generateContent(systemInstruction, userText, apiKey) {
  const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
    }),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Gemini API error: ${resp.status} — ${errBody.slice(0, 200)}`);
  }
  const data = await resp.json();
  // Guard against missing/blocked candidates
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini returned no text — finish_reason: ${data.candidates?.[0]?.finishReason ?? 'unknown'}`);
  return text;
}

/**
 * Classify an IBM Verify audit event by severity.
 * @returns {{ severity: number, summary: string, rationale: string }}
 */
// ---------------------------------------------------------------------------
// Deterministic severity floor — LLMs are unreliable for hard numeric rules.
// This runs AFTER Gemini and clamps the score upward if needed.
// ---------------------------------------------------------------------------
function applyMinimums(event, geminiSeverity) {
  const action = (event.data?.action ?? '').toLowerCase();
  const result = (event.data?.result ?? '').toLowerCase();

  // Authentication failure
  if (result === 'failure' && (action.includes('authn') || action.includes('login') || action.includes('authentication'))) {
    return Math.max(geminiSeverity, 7);
  }
  // MFA removal / deactivation
  if (action.includes('mfa') || action.includes('factor')) {
    if (action.includes('deactivat') || action.includes('remov') || action.includes('delet')) {
      return Math.max(geminiSeverity, 8);
    }
  }
  // Admin password reset or account deletion
  if (action.includes('reset_password') || action.includes('delete') || action.includes('lifecycle.delete')) {
    return Math.max(geminiSeverity, 8);
  }
  // Impersonation / privilege escalation
  if (action.includes('impersonat') || action.includes('escalat') || action.includes('sudo')) {
    return Math.max(geminiSeverity, 9);
  }
  return geminiSeverity;
}

export async function classifyEvent(event, apiKey) {
  const systemInstruction =
    'You are a security analyst. Classify this IBM Verify IAM audit event by severity 0-10 ' +
    '(10=critical). High severity: failed logins, admin account changes, MFA removal, privilege ' +
    'escalation, bulk operations. Low severity: routine SSO logins. ' +
    'Respond with JSON only: {"severity":<int>,"summary":"<one sentence>","rationale":"<why>"}';

  const payload = JSON.stringify({
    event_type: event.event_type,
    time: event.time,
    data: {
      action: event.data?.action,
      result: event.data?.result,
      subtype: event.data?.subtype,
      cause: event.data?.cause,
      username: event.data?.username,
      applicationname: event.data?.applicationname,
      target: event.data?.target,
    },
  });

  let geminiResult;
  try {
    const text = await generateContent(systemInstruction, payload, apiKey);
    geminiResult = extractJson(text);
  } catch {
    // Build a meaningful fallback without Gemini
    const action  = event.data?.action ?? 'unknown';
    const result  = event.data?.result ?? '';
    const user    = event.data?.username || event.data?.userid || 'unknown user';
    const app     = event.data?.applicationname || '';
    const outcome = result === 'failure' ? 'failed' : result === 'success' ? 'succeeded' : 'occurred';
    geminiResult = {
      severity: 5,
      summary: `${action.replace(/\./g, ' ')} ${outcome} for ${user}${app ? ' on ' + app : ''}.`,
      rationale: `Fallback classification — Gemini unavailable. Action: ${action}, Result: ${result || 'unknown'}.`,
    };
  }

  // Always apply deterministic minimums — overrides Gemini when needed
  geminiResult.severity = applyMinimums(event, geminiResult.severity);
  return geminiResult;
}

/**
 * Route a natural-language query to an MCP tool.
 * @returns {{ toolName: string, args: object } | null}
 */
export async function routeQuery(text, apiKey) {
  const systemInstruction =
    'You are an IBM Verify IAM assistant. Available tools:\n' +
    '- ibm_verify_get_user_count — get total number of users\n' +
    '- ibm_verify_get_group_count — get total number of groups\n' +
    '- ibm_verify_list_users — list/search users (args: filter, limit)\n' +
    '- ibm_verify_get_user — get a specific user by ID (args: user_id)\n' +
    '- ibm_verify_list_groups — list/search groups (args: filter, count)\n' +
    '- ibm_verify_list_user_mfa_enrollments — list MFA enrollments for a user (args: user_id)\n' +
    '- ibm_verify_list_applications — list applications (args: search, limit)\n' +
    '- ibm_verify_list_all_mfa_enrollments — list all MFA enrollments across tenant\n' +
    'Given this user query, choose the best tool and extract arguments. ' +
    'Return JSON only: {"toolName":"<name>","args":{...}} or {"toolName":null} if no tool matches.';

  try {
    const responseText = await generateContent(systemInstruction, text, apiKey);
    const parsed = extractJson(responseText);
    if (!parsed.toolName || !ALLOWED_TOOLS.includes(parsed.toolName)) return null;
    return { toolName: parsed.toolName, args: parsed.args ?? {} };
  } catch {
    return null;
  }
}

/**
 * Generate a narrative paragraph summarising a full day of IBM Verify events.
 * @param {object} stats   Tallied counts — { total, byAction, byResult, topUsers }
 * @param {string} apiKey
 * @returns {Promise<string>} plain text narrative (1–3 sentences)
 */
export async function generateDailySummary(stats, apiKey) {
  const systemInstruction =
    'You are a security analyst writing a concise daily IAM security summary for a Slack channel. ' +
    'In 2-3 sentences, describe the key highlights from the day\'s IBM Verify activity. ' +
    'Mention any spikes, failures, or notable patterns. Be factual and direct. No bullet points.';

  // Send a trimmed payload — no byHour array, top 8 actions only
  const topActions = Object.fromEntries(
    Object.entries(stats.byAction).sort((a, b) => b[1] - a[1]).slice(0, 8)
  );
  const trimmed = {
    total:       stats.total,
    successes:   stats.successes,
    failures:    stats.failures,
    alertsFired: stats.alertsFired,
    topActions,
    topUsers:    stats.topUsers?.slice(0, 5),
  };
  const userText = `Today's IBM Verify activity summary:\n${JSON.stringify(trimmed, null, 2)}`;

  try {
    return await generateContent(systemInstruction, userText, apiKey);
  } catch (err) {
    console.error('[Gemini daily narrative]', err.message);
    const topActionEntry = Object.entries(stats.byAction ?? {}).sort((a, b) => b[1] - a[1])[0];
    const topLine = topActionEntry ? ` Most common action: ${topActionEntry[0]} (${topActionEntry[1]}).` : '';
    return `${stats.total} events recorded today with ${stats.failures} failure${stats.failures !== 1 ? 's' : ''} (${stats.total > 0 ? ((stats.failures / stats.total) * 100).toFixed(1) : 0}% failure rate).${topLine} ${stats.alertsFired} alert${stats.alertsFired !== 1 ? 's' : ''} fired.`;
  }
}

/**
 * Generate an analytics insights paragraph for a multi-day IBM Verify report.
 * Looks for trends, anomalies, and actionable observations across the period.
 *
 * @param {object} stats  Tallied counts including byAction, topUsers, failures, byHour
 * @param {number} days   1 | 7 | 30 | 90
 * @param {string} apiKey
 * @returns {Promise<string>} 3–5 sentence plain text insight paragraph
 */
export async function generatePeriodInsights(stats, days, apiKey) {
  const periodLabel = days === 1 ? '24 hours' : `${days} days`;
  const avgPerDay   = days > 1 ? Math.round(stats.total / days) : stats.total;

  // Derive the dominant action and top user from stats for the fallback
  const topAction = Object.entries(stats.byAction).sort((a, b) => b[1] - a[1])[0];
  const topUser   = stats.topUsers?.[0];

  const systemInstruction =
    'You are an IAM security analyst. Analyse the following IBM Verify audit event statistics ' +
    `covering the last ${periodLabel} and write a short analytical paragraph (3–5 sentences) ` +
    'for a security operations Slack channel. ' +
    'Focus on: volume trends, failure rate, dominant activity types, any users with unusually ' +
    'high activity, and whether the pattern looks normal or warrants attention. ' +
    'Be specific — use the numbers provided. Be direct and professional. No bullet points. No headers.';

  const userText =
    `Period: last ${periodLabel}\n` +
    `Average events per day: ${avgPerDay}\n` +
    JSON.stringify({
      total:       stats.total,
      successes:   stats.successes,
      failures:    stats.failures,
      alertsFired: stats.alertsFired,
      failureRate: stats.total > 0 ? ((stats.failures / stats.total) * 100).toFixed(1) + '%' : '0%',
      byAction:    stats.byAction,
      topUsers:    stats.topUsers?.slice(0, 5),
    }, null, 2);

  try {
    return await generateContent(systemInstruction, userText, apiKey);
  } catch {
    const failRate = stats.total > 0
      ? ((stats.failures / stats.total) * 100).toFixed(1)
      : '0';
    return (
      `Over the last ${periodLabel}, IBM Verify recorded ${stats.total.toLocaleString()} events ` +
      `(~${avgPerDay}/day), with a ${failRate}% failure rate. ` +
      (topAction ? `The most common activity was "${topAction[0]}" (${topAction[1]} events). ` : '') +
      (topUser   ? `The most active identity was ${topUser[0]} with ${topUser[1]} events.` : '')
    );
  }
}

/**
 * Generate a single-sentence AI commentary for one section of a summary report.
 * All three calls should be made in parallel via Promise.all.
 *
 * @param {'categories'|'actions'|'users'} section
 * @param {object} data  Section-specific stats
 * @param {number} days  Report window (1 = daily)
 * @param {string} apiKey
 * @returns {Promise<string>}  One sentence, no trailing period duplication
 */
export async function generateSectionCommentary(section, data, days, apiKey) {
  const period = days === 1 ? 'today' : `the last ${days} days`;

  const prompts = {
    categories: {
      system:
        'You are an IAM security analyst. In exactly one sentence (max 20 words), ' +
        'describe the most notable insight about the IAM activity category distribution shown. ' +
        'Be specific about the dominant category and any imbalance. No fluff.',
      user: `Category distribution for ${period}:\n${JSON.stringify(data)}`,
    },
    actions: {
      system:
        'You are an IAM security analyst. In exactly one sentence (max 20 words), ' +
        'comment on the top event action — is it expected, unusually high, or a sign of automation? ' +
        'Be specific. No fluff.',
      user: `Top event actions for ${period} (action: count):\n${JSON.stringify(data)}`,
    },
    users: {
      system:
        'You are an IAM security analyst. In exactly one sentence (max 20 words), ' +
        'flag any user with disproportionately high activity, or confirm the distribution looks normal. ' +
        'Be specific. No fluff.',
      user: `Most active users for ${period} (user: count):\n${JSON.stringify(data)}`,
    },
  };

  const p = prompts[section];
  if (!p) return '';

  try {
    const text = await generateContent(p.system, p.user, apiKey);
    // Strip stray markdown bold/italic that Gemini sometimes adds
    return text.trim().replace(/\*\*/g, '*').split('\n')[0];
  } catch {
    return '';
  }
}

/**
 * Summarise a tool result for a Slack message.
 * @returns {string}
 */
export async function answerQuery(question, toolName, mcpResult, apiKey) {
  const systemInstruction = 'You are a helpful IBM Verify IAM assistant.';
  const userText =
    `The user asked: "${question}". ` +
    `The IBM Verify IAM tool '${toolName}' returned this data: ${mcpResult}. ` +
    'Summarize the result concisely for a Slack message. Use markdown. Keep it under 500 words.';

  try {
    return await generateContent(systemInstruction, userText, apiKey);
  } catch {
    return mcpResult.slice(0, 3000);
  }
}
