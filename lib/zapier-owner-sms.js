// The connected SMS by Zapier action has a fixed owner destination. Never pass a
// caller-supplied destination or select a different action automatically.
export function createZapierOwnerTexter({ env = process.env, fetcher = fetch } = {}) {
  return async ({ body }) => {
    const endpoint = env.ZAPIER_MCP_URL;
    const tool = env.FRONTDESK_ZAPIER_SMS_TOOL_NAME;
    if (!endpoint || !tool) throw new Error('Zapier owner SMS is not configured.');
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.hostname !== 'mcp.zapier.com') throw new Error('Zapier MCP address is invalid.');
    let session;
    let id = 0;
    const rpc = async (method, params) => {
      const response = await fetcher(url.href, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Zapier MCP returned ${response.status}.`);
      session = response.headers.get('mcp-session-id') || session;
      const raw = await response.text();
      let data;
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        const frames = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => { try { return JSON.parse(line.slice(5).trim()); } catch { return null; } });
        data = frames.find(frame => frame?.id === id);
      } else { try { data = JSON.parse(raw); } catch { throw new Error('Zapier returned an invalid response.'); } }
      if (!data || data.error || data.result?.isError) throw new Error('Zapier owner SMS action failed.');
      return data.result;
    };
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'LegacyAI-frontdesk', version: '1.0.0' } });
    const available = await rpc('tools/list', {});
    if (!available?.tools?.some(action => action.name === tool)) throw new Error('Configured Zapier owner SMS action is unavailable.');
    const result = await rpc('tools/call', { name: tool, arguments: { message: String(body).slice(0, 153), output_hint: 'Return the message id, status, to and error details. A queued status is not delivery confirmation.' } });
    // A successful action is an accepted request, not handset delivery proof.
    if (!result) throw new Error('Zapier did not acknowledge the SMS action.');
    return { via: 'zapier', status: 'queued', delivered: false };
  };
}
