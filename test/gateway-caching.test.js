import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeneration } from '../lib/concierge/generation.js';
import { createCompetitorHandler } from '../lib/concierge/competitors.js';
import { createBoardHandler } from '../lib/board-handler.js';
import { receptionistInput } from '../lib/receptionist.js';
import { gatewayProviderOptions } from '../lib/gateway.js';

// Network-free. The pinned Gateway SDK sends through globalThis.fetch unless a
// transport is supplied, so replacing it captures the exact body each call site
// posts. The stub answers with the Gateway's own 401 body: nothing leaves the
// machine, and no test needs live provider traffic.
function captureModelRequests() {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ error: { message: 'Test transport stopped', type: 'authentication_error' } }, { status: 401 });
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

// api/receptionist.js and lib/concierge/competitors.js build their Gateway from
// process.env, so the fixture key is installed for the duration of the test.
function withGatewayKey(t) {
  const names = ['AI_GATEWAY_API_KEY', 'VERCEL', 'VERCEL_OIDC_TOKEN'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });
  process.env.AI_GATEWAY_API_KEY = 'fixture-gateway-key';
  delete process.env.VERCEL;
}

const gatewayOptionsOf = request => request.body?.providerOptions?.gateway;
const stoppedTransport = error => error.name === 'GatewayAuthenticationError';

test('the shared Gateway options add caching without dropping other Gateway keys', () => {
  assert.deepEqual(gatewayProviderOptions(), { gateway: { caching: 'auto' } });
  assert.deepEqual(
    gatewayProviderOptions({ gateway: { models: ['openai/gpt-5.6-terra'] } }),
    { gateway: { caching: 'auto', models: ['openai/gpt-5.6-terra'] } },
  );
});

test('all five concierge generation call sites request automatic caching', async t => {
  const { requests, restore } = captureModelRequests();
  t.after(restore);
  const generation = createGeneration({ AI_GATEWAY_API_KEY: 'fixture-gateway-key' });
  const calls = [
    ['identify', () => generation.identify('My name is Ann and I run Acme Roofing.')],
    ['assistant', () => generation.assistant('Who visited this week?', [])],
    ['chat', () => generation.chat({ messages: [{ role: 'user', content: 'What do you do?' }], serviceIds: [] })],
    ['insights', () => generation.insights({ inquiries: 0 })],
    ['followUp', () => generation.followUp({ name: 'Ann', company: 'Acme', message: 'Please call me.', serviceIds: [] }, 'Keep it short.')],
  ];
  for (const [site, run] of calls) {
    const before = requests.length;
    await assert.rejects(run(), stoppedTransport);
    assert.equal(requests.length, before + 1, `${site} must send exactly one model request`);
    assert.deepEqual(gatewayOptionsOf(requests.at(-1)), { caching: 'auto' }, `${site} must request automatic caching`);
  }
});

test('the receptionist call site requests automatic caching', async t => {
  withGatewayKey(t);
  const { requests, restore } = captureModelRequests();
  t.after(restore);
  const { generate } = await import('../api/receptionist.js');
  const input = receptionistInput.parse({
    profile: { business: 'Acme Plumbing', hours: 'Mon-Fri 8-5', services: [{ name: 'Drain cleaning', price: 'from $149' }], languages: ['en', 'es'] },
    slots: [{ id: '20261005T0900', label: 'Monday, October 5, 9:00 AM–10:00 AM' }],
    messages: [{ role: 'caller', content: 'Can I book a drain cleaning?' }],
  });
  await assert.rejects(generate(input), stoppedTransport);
  assert.equal(requests.length, 1);
  assert.deepEqual(gatewayOptionsOf(requests[0]), { caching: 'auto' });
});

test('competitor research synthesis requests automatic caching', async t => {
  withGatewayKey(t);
  const { requests, restore } = captureModelRequests();
  t.after(restore);
  // The real synthesis call runs; only the page retrieval and the store are faked.
  const handler = createCompetitorHandler({
    requireOwner: async () => ({ subject: 'owner-test' }),
    store: () => ({ consumeLimits: async () => {} }),
    fetchSource: async url => ({ requestedUrl: url, url, title: 'Public page', excerpt: 'Repairs are advertised.', asOf: '2026-10-13T00:00:00.000Z' }),
  });
  const response = await handler(new Request('https://legacyai.space/api/owner/competitors', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ urls: ['https://example.com'] }),
  }));
  assert.equal(response.status, 502, 'the stopped transport surfaces as a synthesis failure');
  assert.equal(requests.length, 1);
  assert.deepEqual(gatewayOptionsOf(requests[0]), { caching: 'auto' });
});

test('the Board sends its fallback models and automatic caching together', async () => {
  let options;
  const handler = createBoardHandler({
    env: { AI_GATEWAY_API_KEY: 'fixture-gateway-key' },
    streamText: input => { options = input; return { textStream: (async function* () { yield 'Report.' })() }; },
  });
  const response = await handler(new Request('https://legacyai.space/api/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Should we add a second service truck?' }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(options.providerOptions, { gateway: { caching: 'auto', models: ['openai/gpt-5.6-terra'] } });
  assert.equal(options.model, 'anthropic/claude-sonnet-4.6');
});
