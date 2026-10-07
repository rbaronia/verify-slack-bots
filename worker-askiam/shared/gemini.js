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
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini returned no text — finish_reason: ${data.candidates?.[0]?.finishReason ?? 'unknown'}`);
  return text;
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
 * Summarise a tool result for a Slack message.
 * @returns {Promise<string>}
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
