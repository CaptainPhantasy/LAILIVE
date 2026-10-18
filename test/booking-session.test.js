import test from 'node:test';
import assert from 'node:assert/strict';
import { createBookingCalendarProvider, LEGACY_BOOKING_CALENDAR_ID } from '../lib/booking-live-provider.js';

const env = { BOOKING_ZAPIER_MCP_URL: 'https://mcp.zapier.com/api/mcp/test', BOOKING_ZAPIER_GET_TOOL: 'get', BOOKING_ZAPIER_WRITE_TOOL: 'write', BOOKING_CALENDAR_ID: LEGACY_BOOKING_CALENDAR_ID };
function fixture() {
  let initializations = 0, nextStatus = 200, rejected = 0;
  const actions = [], handshakes = [];
  const provider = createBookingCalendarProvider({ env, fetcher: async (_url, options) => {
    const rpc = JSON.parse(options.body), session = options.headers['Mcp-Session-Id'];
    let result;
    if (rpc.method === 'initialize') { initializations++; result = {}; }
    else if (rpc.method === 'notifications/initialized') {
      handshakes.push(session);
      return new Response(null, { status: 202 });
    } else if (rpc.method === 'tools/list') result = { tools: ['get', 'write'].map(name => ({ name, inputSchema: { properties: { url: {}, method: {}, body: {} } } })) };
    else {
      if (nextStatus !== 200) {
        rejected++;
        const status = nextStatus; nextStatus = 200;
        return new Response(null, { status });
      }
      actions.push({ session, args: rpc.params.arguments });
      result = { structuredContent: { kind: 'calendar#event', id: 'confirmed-event' } };
    }
    return Response.json({ id: rpc.id, result }, { headers: { 'Mcp-Session-Id': `session-${initializations}` } });
  } });
  return { provider, actions, handshakes, expire(status = 404) { nextStatus = status; }, get initializations() { return initializations; }, get rejected() { return rejected; } };
}

test('expired calendar sessions reinitialize once for reads and writes', async () => {
  for (const operation of ['get', 'insert']) {
    const f = fixture();
    await f.provider.get('confirmed-event');
    f.expire();
    const result = await f.provider[operation](operation === 'get' ? 'confirmed-event' : { id: 'confirmed-event' });
    assert.equal(result.id, 'confirmed-event');
    assert.equal(f.initializations, 2);
    assert.deepEqual(f.handshakes, ['session-1', 'session-2']);
    assert.equal(f.rejected, 1);
    assert.equal(f.actions.length, 2);
    assert.equal(f.actions.at(-1).session, 'session-2');
    await f.provider.get('confirmed-event');
    assert.equal(f.initializations, 2, 'the recovered connection is reusable');
  }
});

test('other provider failures never replay a possibly accepted calendar write', async () => {
  const f = fixture();
  await f.provider.get('confirmed-event');
  f.expire(500);
  await assert.rejects(f.provider.insert({ id: 'confirmed-event' }), /request failed/);
  assert.equal(f.initializations, 1);
  assert.equal(f.rejected, 1);
  assert.equal(f.actions.length, 1);
});

test('repeated session expiration stops after one reinitialization', async () => {
  let initializations = 0, attempts = 0;
  const provider = createBookingCalendarProvider({ env, fetcher: async (_url, options) => {
    const rpc = JSON.parse(options.body);
    if (rpc.method === 'initialize') { initializations++; return Response.json({ id: rpc.id, result: {} }, { headers: { 'Mcp-Session-Id': `session-${initializations}` } }); }
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (rpc.method === 'tools/list') return Response.json({ id: rpc.id, result: { tools: ['get', 'write'].map(name => ({ name, inputSchema: { properties: { url: {}, method: {}, body: {} } } })) } });
    attempts++; return new Response(null, { status: 404 });
  } });
  await assert.rejects(provider.get('event'), /session|request failed/i);
  assert.equal(initializations, 2);
  assert.equal(attempts, 2);
});

test('concurrent expired requests share one replacement connection', async () => {
  let initializations = 0, expired = false;
  const provider = createBookingCalendarProvider({ env, fetcher: async (_url, options) => {
    const rpc = JSON.parse(options.body), session = options.headers['Mcp-Session-Id'];
    if (rpc.method === 'initialize') { initializations++; return Response.json({ id: rpc.id, result: {} }, { headers: { 'Mcp-Session-Id': `session-${initializations}` } }); }
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (rpc.method === 'tools/list') return Response.json({ id: rpc.id, result: { tools: ['get', 'write'].map(name => ({ name, inputSchema: { properties: { url: {}, method: {}, body: {} } } })) } });
    if (expired && session === 'session-1') return new Response(null, { status: 404 });
    return Response.json({ id: rpc.id, result: { structuredContent: { kind: 'calendar#event', id: 'event' } } });
  } });
  await provider.get('event'); expired = true;
  const results = await Promise.all([provider.get('event'), provider.get('event')]);
  assert.equal(results.length, 2);
  assert.equal(initializations, 2);
});
