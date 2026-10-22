/**
 * @file shared/gemini.js
 * @description LLM routing and answer-formatting layer for AskIAM.
 *
 * Responsibilities
 * ────────────────
 * 1. Tool registry — defines all 34 IBM Verify MCP tools with descriptions
 *    used in LLM prompts, grouped by persona (admin / end_user).
 * 2. Input sanitisation — rejects prompt-injection patterns before any LLM
 *    call; strips nested objects from LLM-returned args (sanitiseArgs).
 * 3. LLM provider chain — tries Gemini models in order (quota-aware), falls
 *    back to Groq automatically if all Gemini models fail.
 * 4. routeQuery() — sends the user's natural-language query to the LLM and
 *    returns { toolName, args, persona } identifying the best MCP tool to call.
 * 5. answerQuery() — sends the raw MCP tool result back to the LLM and
 *    returns a structured { query, summary, bullets[], footer } object for
 *    Block Kit assembly, with optional server-side pagination.
 *
 * Exported symbols
 * ────────────────
 * sanitiseQuery(text)                             — input guard (called by index.js before routeQuery)
 * routeQuery(text, geminiKey, groqKey)            → { toolName, args, persona } | null
 * answerQuery(question, toolName, mcpResult,
 *             geminiKey, groqKey, page, pageSize) → { query, summary, bullets, footer }
 *
 * KV / secrets used (passed in as arguments, never imported directly)
 * ────────────────────────────────────────────────────────────────────
 * GEMINI_API_KEY — Google AI Studio key; 8 s per-model timeout
 * GROQ_API_KEY   — Groq key; model openai/gpt-oss-120b; 20 s timeout
 */

// ---------------------------------------------------------------------------
// LLM provider config
// ---------------------------------------------------------------------------
const GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ---------------------------------------------------------------------------
// Tool registry — all 34 IBM Verify MCP tools, grouped by persona
// ---------------------------------------------------------------------------

const ADMIN_TOOLS = [
  // User Management (admin)
  { name: 'ibm_verify_get_user_count',        desc: 'Return total number of users in the tenant' },
  { name: 'ibm_verify_list_users',            desc: 'List/search users (args: filter, count, sortBy)' },
  { name: 'ibm_verify_get_user',              desc: 'Get full profile + group memberships for a user (args: user_id)' },
  { name: 'ibm_verify_create_user',           desc: 'Create a new user (args: userName, givenName, familyName, email, department, ...)' },
  { name: 'ibm_verify_update_user',           desc: 'Update user attributes (args: user_id, attributes to change)' },
  { name: 'ibm_verify_delete_user',           desc: 'Permanently delete a user (args: user_id)' },
  { name: 'ibm_verify_reset_user_password',   desc: 'Admin password reset — emails a temp password to the user (args: user_id)' },
  // Group Management (admin)
  { name: 'ibm_verify_get_group_count',       desc: 'Return total number of groups in the tenant' },
  { name: 'ibm_verify_list_groups',           desc: 'List/search groups (args: filter, count, sortBy)' },
  { name: 'ibm_verify_create_group',          desc: 'Create a new group (args: displayName, members)' },
  { name: 'ibm_verify_update_group',          desc: 'Add/remove members or rename a group (args: group_id, addMembers, removeMembers, displayName)' },
  { name: 'ibm_verify_delete_group',          desc: 'Permanently delete a group (args: group_id)' },
  // Application Management (admin)
  { name: 'ibm_verify_list_applications',     desc: 'List/search applications (args: search, limit)' },
  { name: 'ibm_verify_get_application',       desc: 'Get full config for an application (args: app_id)' },
  { name: 'ibm_verify_list_application_types',      desc: 'List all supported application types that can be created' },
  { name: 'ibm_verify_get_application_requirements', desc: 'Get required fields for a given application type (args: type_id)' },
  { name: 'ibm_verify_create_application',    desc: 'Register a new application (args: type, name, redirectUris, ...)' },
  { name: 'ibm_verify_update_application',    desc: 'Update specific fields of an existing application (args: app_id, fields)' },
  { name: 'ibm_verify_delete_application',    desc: 'Permanently delete an application (args: app_id)' },
  // MFA Management (admin)
  { name: 'ibm_verify_list_all_mfa_enrollments',   desc: 'List all MFA enrollments across the entire tenant' },
  { name: 'ibm_verify_list_mfa_factors',      desc: 'List MFA methods enabled in the tenant' },
  // Directory Attributes (admin)
  { name: 'ibm_verify_list_directory_attributes', desc: 'List/search tenant directory attributes (args: filter, count)' },
];

const USER_TOOLS = [
  // User Management (end_user)
  { name: 'ibm_verify_initiate_my_password_reset', desc: 'Start self-service forgot-password flow (args: username)' },
  // MFA Management (end_user + admin)
  { name: 'ibm_verify_list_user_mfa_enrollments',  desc: 'List MFA enrollments for the current user (end_user persona: no args needed; admin persona: args: user_id)' },
  { name: 'ibm_verify_delete_mfa_enrollment',      desc: 'Delete a specific MFA enrollment (args: user_id, enrollment_id)' },
  // Access Requests (end_user)
  { name: 'ibm_verify_get_my_access_assignments',  desc: 'Get all active access assignments for the current user' },
  { name: 'ibm_verify_list_requestable_applications', desc: 'Browse apps the current user can request access to' },
  { name: 'ibm_verify_get_application_entitlements',  desc: 'List roles/permissions available to request for an application (args: app_id)' },
  { name: 'ibm_verify_create_access_request',      desc: 'Submit an access request (args: app_id, entitlement_id, justification)' },
  { name: 'ibm_verify_list_my_access_requests',    desc: 'View access requests submitted by the current user' },
  { name: 'ibm_verify_remind_access_approvers',    desc: 'Send a reminder to approvers on a pending request (args: request_id)' },
  { name: 'ibm_verify_cancel_access_requests',     desc: 'Cancel pending access requests (args: request_ids)' },
  { name: 'ibm_verify_list_access_requests_pending_my_approval', desc: 'List access requests waiting for the current user to approve' },
  { name: 'ibm_verify_review_access_request',      desc: 'Approve or reject an access request (args: request_id, decision, justification)' },
];

// Tools callable by either persona (routing logic handles persona selection)
const SHARED_TOOLS = ['ibm_verify_list_user_mfa_enrollments', 'ibm_verify_delete_mfa_enrollment'];

const ALL_TOOLS      = [...ADMIN_TOOLS, ...USER_TOOLS];
const ALL_TOOL_NAMES = ALL_TOOLS.map(t => t.name);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse JSON from an LLM response that may or may not be wrapped in a
 * markdown code fence (```json ... ```).
 * @param {string} text
 * @returns {*} Parsed JSON value
 * @throws {SyntaxError} if no valid JSON is found
 */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  return JSON.parse(raw.trim());
}

// ---------------------------------------------------------------------------
// Input sanitisation — prompt injection defence (Security: C2)
// ---------------------------------------------------------------------------

/**
 * Regex covering common prompt-injection trigger phrases.
 * Tested case-insensitively; reset between calls via the `g` flag.
 */
const INJECTION_PATTERN =
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?|forget\s+everything|disregard\s+(all\s+)?instructions?|system\s*:/gi;

/**
 * Validate and sanitise a raw user query before it is sent to the LLM.
 * Exported so index.js can call it at the entry point of every request.
 *
 * @param {string} text — Raw query text from the Slack slash command
 * @returns {string}    — Sanitised query, truncated to 500 characters
 * @throws {Error}      — If the query is empty, not a string, or matches
 *                        a known prompt-injection pattern
 */
export function sanitiseQuery(text) {
  if (!text || typeof text !== 'string') throw new Error('Invalid query.');
  if (INJECTION_PATTERN.test(text)) throw new Error('Query contains disallowed content.');
  return text.slice(0, 500);
}

/**
 * Strip any nested objects or arrays from LLM-returned tool arguments.
 * Only primitive values (string, number, boolean) are passed to the MCP server.
 * This prevents an injected LLM response from smuggling structured payloads.
 *
 * @param {object} args — Raw args object from LLM JSON output
 * @returns {object}    — Sanitised args containing only primitive values
 */
function sanitiseArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const safe = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      safe[k] = v;
    }
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Gemini — try each model in order, skip on quota / availability errors
// ---------------------------------------------------------------------------

/**
 * Attempt to generate content using the Gemini API, cycling through
 * GEMINI_MODELS until one succeeds or all are exhausted.
 *
 * Skips a model silently on HTTP 404 (model not found), 429 (quota), or
 * 503 (overloaded). Any other non-2xx status throws immediately.
 *
 * @param {string} systemInstruction — LLM system prompt
 * @param {string} userText          — User turn content
 * @param {string} geminiKey         — Google AI Studio API key
 * @returns {Promise<string|null>}   — Generated text, or null if all models failed
 */
async function tryGemini(systemInstruction, userText, geminiKey) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
  });

  for (const model of GEMINI_MODELS) {
    const url = `${GEMINI_BASE}/${model}:generateContent?key=${geminiKey}`;
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000),
        body,
      });
    } catch (err) {
      console.warn(`[Gemini] ${model} fetch failed: ${err.message}`);
      continue;
    }
    if (resp.status === 429 || resp.status === 503 || resp.status === 404) {
      console.warn(`[Gemini] ${model} returned ${resp.status} — skipping`);
      continue;
    }
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`Gemini error ${resp.status}: ${errBody.slice(0, 200)}`);
    }
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) return text;
  }
  return null; // all Gemini models failed
}

// ---------------------------------------------------------------------------
// Groq fallback — OpenAI-compatible chat completions API
// ---------------------------------------------------------------------------

/**
 * Attempt to generate content using the Groq API (OpenAI-compatible endpoint).
 * Used as a fallback when all Gemini models are unavailable or quota-exhausted.
 *
 * Returns null (rather than throwing) on network failure or 429 quota errors
 * so the caller can surface a clean "all providers unavailable" message.
 *
 * @param {string} systemInstruction — LLM system prompt
 * @param {string} userText          — User turn content
 * @param {string} groqKey           — Groq API key
 * @returns {Promise<string|null>}   — Generated text, or null on recoverable failure
 */
async function tryGroq(systemInstruction, userText, groqKey) {
  if (!groqKey) return null;
  let resp;
  try {
    resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`,
      },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user',   content: userText },
        ],
        temperature: 0.1,
      }),
    });
  } catch (err) {
    console.warn(`[Groq] fetch failed: ${err.message}`);
    return null;
  }
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    console.warn(`[Groq] error ${resp.status}: ${errBody.slice(0, 300)}`);
    // 429 = quota, return null to surface final error; others throw for visibility
    if (resp.status === 429) return null;
    throw new Error(`Groq error ${resp.status}: ${errBody.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? null;
}

// ---------------------------------------------------------------------------
// generateContent — provider chain: Gemini → Groq
// ---------------------------------------------------------------------------

/**
 * Generate LLM content, trying Gemini models first and falling back to Groq.
 * Throws only when every provider has been exhausted.
 *
 * @param {string} systemInstruction
 * @param {string} userText
 * @param {string} geminiKey
 * @param {string} groqKey
 * @returns {Promise<string>} — Generated text
 * @throws {Error}            — If all providers fail
 */
async function generateContent(systemInstruction, userText, geminiKey, groqKey) {
  const text = await tryGemini(systemInstruction, userText, geminiKey);
  if (text) return text;

  console.warn('[LLM] All Gemini models unavailable — falling back to Groq');
  const groqText = await tryGroq(systemInstruction, userText, groqKey);
  if (groqText) return groqText;

  throw new Error('All LLM providers unavailable (Gemini quota exhausted, Groq unreachable). Please try again in a moment.');
}

function buildToolList(tools) {
  return tools.map(t => `- ${t.name} — ${t.desc}`).join('\n');
}

// ---------------------------------------------------------------------------
// routeQuery — map a natural-language query to an MCP tool call
// ---------------------------------------------------------------------------

/**
 * Send the user's query to the LLM and determine which IBM Verify MCP tool
 * to call, which arguments to pass, and which persona (admin / end_user) to
 * use for the MCP request.
 *
 * The LLM output is validated against ALL_TOOL_NAMES and args are sanitised
 * with sanitiseArgs() before being returned — the caller should not assume
 * the LLM output is safe to use directly.
 *
 * @param {string} text     — Sanitised user query (output of sanitiseQuery)
 * @param {string} apiKey   — Gemini API key
 * @param {string} groqKey  — Groq API key (fallback)
 * @returns {Promise<{toolName: string, args: object, persona: string}|null>}
 *   — Routing result, or null if no suitable tool was found
 * @throws {Error} — If all LLM providers fail
 */
export async function routeQuery(text, apiKey, groqKey) {
  const systemInstruction =
    'You are an IBM Verify IAM assistant. Route the user query to the best tool.\n\n' +
    'ADMIN tools (persona=admin):\n' +
    buildToolList(ADMIN_TOOLS) + '\n\n' +
    'END_USER tools (persona=end_user — also includes the two MFA tools above):\n' +
    buildToolList(USER_TOOLS) + '\n\n' +
    'Rules:\n' +
    '1. Pick the single best tool. If nothing fits, return {"toolName":null}.\n' +
    '2. Return ONLY valid JSON: {"toolName":"<name>","args":{...},"persona":"admin"|"end_user"}\n' +
    '3. For end_user tools use persona="end_user"; for admin tools use persona="admin".\n' +
    '4. ibm_verify_list_user_mfa_enrollments: use persona="end_user" with args={} when the user says "my MFA" or "my enrollments" (no user_id needed — server uses token). Use persona="admin" with args={user_id:...} only when a specific user is named.\n' +
    '5. Extract as many args as can be inferred from the query. Omit args you cannot determine.\n' +
    '6. Do not include markdown or explanation — JSON only.';

  try {
    const responseText = await generateContent(systemInstruction, text, apiKey, groqKey);
    let parsed;
    try {
      parsed = extractJson(responseText);
    } catch {
      console.warn('[routeQuery] JSON parse failed, response:', responseText?.slice(0, 200));
      return null;
    }
    if (!parsed.toolName || !ALL_TOOL_NAMES.includes(parsed.toolName)) return null;
    const persona = parsed.persona === 'end_user' ? 'end_user' : 'admin';
    return { toolName: parsed.toolName, args: sanitiseArgs(parsed.args), persona };
  } catch (err) {
    throw new Error(`Routing failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// answerQuery — format an MCP tool result into a Block Kit-ready structure
// ---------------------------------------------------------------------------

/**
 * Send the raw MCP tool result to the LLM and produce a structured summary
 * suitable for assembly into a Slack Block Kit message.
 *
 * The LLM is asked to return a JSON object with the schema:
 *   { query, summary, bullets[], footer }
 *
 * On any LLM or parse failure, falls back gracefully to a plain-text object
 * so the caller always receives the same shape regardless of provider state.
 *
 * @param {string} question   — Original user query (for context in the prompt)
 * @param {string} toolName   — MCP tool that was called (e.g. 'ibm_verify_list_users')
 * @param {string} mcpResult  — Raw text content from the MCP tool response
 * @param {string} apiKey     — Gemini API key
 * @param {string} groqKey    — Groq API key (fallback)
 * @param {number} [page=0]   — 0-based page index for pagination
 * @param {number} [pageSize=10] — Items per page; 0 = include all items
 * @returns {Promise<{query: string, summary: string, bullets: string[], footer: string}>}
 */
export async function answerQuery(question, toolName, mcpResult, apiKey, groqKey, page = 0, pageSize = 10) {
  const systemInstruction =
    'You are an IBM Verify IAM assistant. Return ONLY a JSON object — no markdown fences, no extra text.\n\n' +
    'Schema:\n' +
    '{\n' +
    '  "query": "<the original question, unchanged>",\n' +
    '  "summary": "<2-3 sentence plain-English summary: total count, breakdown by type, any notable highlights>",\n' +
    '  "bullets": ["<item 1>", "<item 2>", ...],\n' +
    '  "footer": "<e.g. showing 10 of 82 total — or empty string if not truncated>"\n' +
    '}\n\n' +
    'Bullet format rules by data type (use Slack mrkdwn *bold* and _italic_ inside strings):\n' +
    '  Access assignments: "*<Application>* — <Entitlement>"\n' +
    '    - Admin roles first (A-Z), then permissions (A-Z).\n' +
    '    - Append " _(admin role)_" only when type is an admin role. Omit for plain permissions.\n' +
    '    - Deduplicate identical rows (same app + entitlement + type).\n' +
    '    - If application name is null/empty/NA, use the entitlement name.\n' +
    '  Users: "*<Full Name>* — <email> · _<status>_ · <department>"\n' +
    '  Access requests: "*<Application>* — <Entitlement> · _<status>_ · <date>"\n' +
    '  Pending approvals: "*<Requester>* wants *<Entitlement>* on <Application> · <date>"\n' +
    '  MFA enrollments: "*<Factor Type>* — <device/method> · _<status>_"\n' +
    '  Groups: "*<Name>* — <N> members"\n' +
    '  Applications: "*<Name>* — <type> · _<status>_"\n\n' +
    'General rules:\n' +
    '  - Never include "NA", "null", "undefined", or "(permission)" anywhere.\n' +
    '  - Use *bold* and _italic_ inside bullet strings. No ** markdown, no HTML.\n' +
    '  - For single-value answers (counts), set bullets to [] and put the answer in summary.\n' +
    '  - Keep each bullet under 120 characters.\n' +
    '  - Return valid JSON only — no extra keys, no trailing commas.';

  const pageNote = pageSize > 0
    ? `Include only items ${page * pageSize + 1}–${(page + 1) * pageSize} in the bullets array ` +
      `(0-based index ${page * pageSize} to ${(page + 1) * pageSize - 1}). ` +
      'Always include the total count in the summary.'
    : 'Include ALL items in the bullets array. Include the total count in the summary.';

  const userText =
    `The user asked: "${question}". ` +
    `The IBM Verify tool '${toolName}' returned: ${mcpResult}. ` +
    pageNote;

  try {
    const raw = await generateContent(systemInstruction, userText, apiKey, groqKey);
    // Strip markdown code fences if Gemini wraps the JSON
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(cleaned);
  } catch (err) {
    console.warn('[answerQuery] LLM parse failed, returning raw result. Error:', err.message);
    return {
      query:   question,
      summary: mcpResult.slice(0, 400),
      bullets: [],
      footer:  '',
    };
  }
}
