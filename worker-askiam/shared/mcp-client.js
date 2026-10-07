const MCP_URL = 'https://mcp.baronia.work/mcp';

/**
 * Call an MCP tool via the verify-mcp-server using a user Bearer token
 * obtained through the auth-code flow.
 *
 * Throws with message containing "401" if the token is rejected so the
 * caller can attempt a refresh.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {string} bearerToken  — access_token from IBM Verify auth-code flow
 * @returns {Promise<string>}   — text content from the tool response
 */
export async function callTool(toolName, args, bearerToken) {
  const resp = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${bearerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method:  'tools/call',
      params:  { name: toolName, arguments: args },
      id:      1,
    }),
  });

  if (resp.status === 401) {
    throw new Error(`401 Unauthorized — token rejected by MCP server`);
  }

  const result = await resp.json();
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result.result?.content?.[0]?.text ?? JSON.stringify(result.result);
}
