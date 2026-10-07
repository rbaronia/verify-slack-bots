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

// Tools available to both personas
const SHARED_TOOLS = ['ibm_verify_list_user_mfa_enrollments', 'ibm_verify_delete_mfa_enrollment'];

const ALL_TOOLS     = [...ADMIN_TOOLS, ...USER_TOOLS];
const ALL_TOOL_NAMES = ALL_TOOLS.map(t => t.name);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  return JSON.parse(raw.trim());
}

async function generateContent(systemInstruction, userText, apiKey) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
  });

  const delays = [0, 1000]; // immediate + 1 retry at 1s

  for (const model of GEMINI_MODELS) {
    const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;
    for (const delay of delays) {
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(8000),
          body,
        });
      } catch (fetchErr) {
        // Timeout or network error — try next attempt/model
        console.warn(`[Gemini] ${model} attempt failed: ${fetchErr.message}`);
        continue;
      }
      if (resp.status === 429 || resp.status === 503) continue; // retry or next model
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        // 404 = model gone — try next model immediately
        if (resp.status === 404) break;
        throw new Error(`Gemini API error: ${resp.status} — ${errBody.slice(0, 200)}`);
      }
      const data = await resp.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error(`Gemini returned no text — finish_reason: ${data.candidates?.[0]?.finishReason ?? 'unknown'}`);
      return text;
    }
  }

  throw new Error('Gemini unavailable — all models returned 429/503. Please try again in a moment.');
}

function buildToolList(tools) {
  return tools.map(t => `- ${t.name} — ${t.desc}`).join('\n');
}

// ---------------------------------------------------------------------------
// routeQuery — pick the best tool and extract args
// Returns { toolName, args, persona } or null
// ---------------------------------------------------------------------------
export async function routeQuery(text, apiKey) {
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
    const responseText = await generateContent(systemInstruction, text, apiKey);
    const parsed = extractJson(responseText);
    if (!parsed.toolName || !ALL_TOOL_NAMES.includes(parsed.toolName)) return null;
    const persona = parsed.persona === 'end_user' ? 'end_user' : 'admin';
    return { toolName: parsed.toolName, args: parsed.args ?? {}, persona };
  } catch (err) {
    throw new Error(`Routing failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// answerQuery — returns a structured object { query, summary, bullets, footer }
// that the caller assembles into Block Kit blocks.
// page     — 0-based page index (default 0 = first 10)
// pageSize — rows per page (default 10; 0 = show all)
// ---------------------------------------------------------------------------
export async function answerQuery(question, toolName, mcpResult, apiKey, page = 0, pageSize = 10) {
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
    const raw = await generateContent(systemInstruction, userText, apiKey);
    // Strip markdown code fences if Gemini wraps the JSON
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(cleaned);
  } catch {
    // Fallback: plain text object so the caller always gets the same shape
    return {
      query:   question,
      summary: mcpResult.slice(0, 400),
      bullets: [],
      footer:  '',
    };
  }
}
