const TOKEN_URL = 'https://baronia.verify.ibm.com/oauth2/token';
const MCP_URL = 'https://mcp.baronia.work/mcp';

/**
 * Obtain a client_credentials Bearer token from IBM Verify SaaS.
 * @returns {Promise<string>} access_token
 */
export async function getToken(clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) throw new Error(`token request failed: ${resp.status}`);
  const json = await resp.json();
  return json.access_token;
}

/**
 * Call an MCP tool via the verify-mcp-server.
 * @returns {Promise<string>} text content from the tool response
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
      method: 'tools/call',
      params: { name: toolName, arguments: args },
      id: 1,
    }),
  });

  const result = await resp.json();
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result.result?.content?.[0]?.text ?? JSON.stringify(result.result);
}
