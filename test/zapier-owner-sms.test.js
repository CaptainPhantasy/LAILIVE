import test from 'node:test';
import assert from 'node:assert/strict';
import { createZapierOwnerTexter } from '../lib/zapier-owner-sms.js';
const env = { ZAPIER_MCP_URL: 'https://mcp.zapier.com/api/v1/connect?token=test', FRONTDESK_ZAPIER_SMS_TOOL_NAME: 'owner_sms' };
test('owner SMS initializes MCP and invokes only configured tool without a caller recipient', async () => {
  const calls = [];
  const send = createZapierOwnerTexter({ env, fetcher: async (url, init) => { const request = JSON.parse(init.body); calls.push(request); return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'initialize' ? { protocolVersion: '2024-11-05' } : request.method === 'tools/list' ? { tools: [{ name: 'owner_sms' }] } : { content: [{ type: 'text', text: 'queued' }] } }); } });
  assert.deepEqual(await send({ to: '+19999999999', body: 'Owner report' }), { via: 'zapier', status: 'queued', delivered: false });
  assert.equal(calls[0].method, 'initialize');
  assert.deepEqual(calls[2].params, { name: 'owner_sms', arguments: { message: 'Owner report' } });
});
test('configuration, provider errors and action errors fail closed', async () => {
  await assert.rejects(createZapierOwnerTexter({ env: {} })({ body: 'test' }), /not configured/);
  await assert.rejects(createZapierOwnerTexter({ env: { ...env, ZAPIER_MCP_URL: 'https://other.test/' } })({ body: 'test' }), /invalid/);
  await assert.rejects(createZapierOwnerTexter({ env, fetcher: async () => new Response('', { status: 401 }) })({ body: 'test' }), /401/);
  await assert.rejects(createZapierOwnerTexter({ env, fetcher: async (_, init) => Response.json({ id: JSON.parse(init.body).id, result: { isError: true } }) })({ body: 'test' }), /failed/);
});
test('SSE transport supports initialized replies and accepts no delivery claim', async () => {
  const send = createZapierOwnerTexter({ env, fetcher: async (_, init) => new Response(`data: ${JSON.stringify({ id: JSON.parse(init.body).id, result: JSON.parse(init.body).method === 'tools/list' ? { tools: [{ name: 'owner_sms' }] } : { content: [] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal((await send({ body: 'test' })).delivered, false);
});

test('missing SMS tool is not substituted with email or a different action', async () => {
 const send = createZapierOwnerTexter({ env, fetcher: async (_, init) => Response.json({ id: JSON.parse(init.body).id, result: { tools: [{ name: 'gmail_send_email' }] } }) });
 await assert.rejects(send({ body: 'test' }), /unavailable/);
});
