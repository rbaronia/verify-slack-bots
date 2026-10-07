const MCP_URL = 'https://mcp.baronia.work/mcp';

/**
 * Parse a response that may be application/json or text/event-stream (SSE).
 * For SSE, extract the first 'data:' line that contains a JSON-RPC result/error.
 */
async function parseJsonRpcResponse(resp) {
  const ct = resp.headers.get('content-type') ?? '';
  const text = await resp.text();

  if (ct.includes('text/event-stream')) {
    // Extract data lines from SSE stream
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        const json = line.slice(5).trim();
        if (json && json !== '[DONE]') {
          try { return JSON.parse(json); } catch { /* skip */ }
        }
      }
    }
    throw new Error(`MCP SSE response contained no parseable data line: ${text.slice(0, 200)}`);
  }

  return JSON.parse(text);
}

/**
 * Build common headers for every MCP request.
 */
function mcpHeaders(bearerToken, cfAccess, sessionId) {
  return {
    'Authorization': `Bearer ${bearerToken}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'persona': cfAccess.persona ?? 'admin',
    ...(sessionId                ? { 'mcp-session-id':          sessionId }           : {}),
    ...(cfAccess?.clientId      ? { 'CF-Access-Client-Id':     cfAccess.clientId }    : {}),
    ...(cfAccess?.clientSecret  ? { 'CF-Access-Client-Secret': cfAccess.clientSecret }: {}),
  };
}

/**
 * Send MCP initialize and return the session ID.
 */
async function initSession(bearerToken, cfAccess) {
  const resp = await fetch(MCP_URL, {
    method: 'POST',
    headers: mcpHeaders(bearerToken, cfAccess, null),
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method:  'initialize',
      params:  {
        protocolVersion: '2024-11-05',
        capabilities:    {},
        clientInfo:      { name: 'askiam-worker', version: '1.0.0' },
      },
      id: 0,
    }),
  });

  if (resp.status === 401) throw new Error('401 Unauthorized — token rejected by MCP server');
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`MCP init error ${resp.status}: ${body.slice(0, 200)}`);
  }

  const sessionId = resp.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('MCP server did not return a session ID');
  return sessionId;
}

/**
 * Call an MCP tool via the verify-mcp-server using a user Bearer token.
 *
 * Throws with message containing "401" if the token is rejected so the
 * caller can attempt a refresh.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {string} bearerToken  — access_token from IBM Verify auth-code flow
 * @param {{ clientId?: string, clientSecret?: string }} [cfAccess]
 * @returns {Promise<string>}   — text content from the tool response
 */
export async function callTool(toolName, args, bearerToken, cfAccess = {}) {
  const sessionId = await initSession(bearerToken, cfAccess);

  const resp = await fetch(MCP_URL, {
    method: 'POST',
    headers: mcpHeaders(bearerToken, cfAccess, sessionId),
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method:  'tools/call',
      params:  { name: toolName, arguments: args },
      id:      1,
    }),
  });

  if (resp.status === 401) throw new Error('401 Unauthorized — token rejected by MCP server');
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`MCP server error ${resp.status}: ${body.slice(0, 200)}`);
  }

  const result = await parseJsonRpcResponse(resp);
  if (result.error) throw new Error(`MCP tool error: ${result.error.message ?? JSON.stringify(result.error)}`);
  return result.result?.content?.[0]?.text ?? JSON.stringify(result.result);
}
