import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { ConciergeAgent } from '@signalwire/sdk';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createStore } from '../lib/concierge/store.js';
import { createLegacyConciergeAgent, createConciergeFetch, knowledgeDocuments, KNOWLEDGE_SHA256, AGENT_ROUTE } from '../lib/receptionist-concierge.js';

const origin = 'https://preview.example.test';
const env = { VERCEL_ENV: 'preview', RECEPTIONIST_SIGNALWIRE_ENABLED: 'true', RECEPTIONIST_PREVIEW_ORIGIN: origin, RECEPTIONIST_WEBHOOK_SECRET: 'w'.repeat(40), RECEPTIONIST_SESSION_SECRET: 's'.repeat(40) };
const authorization = `Basic ${Buffer.from(`receptionist:${env.RECEPTIONIST_WEBHOOK_SECRET}`).toString('base64')}`;
const options = getStore => ({ origin, webhookSecret: env.RECEPTIONIST_WEBHOOK_SECRET, sessionSecret: env.RECEPTIONIST_SESSION_SECRET, getStore });
const request = (url, body, authorized = true) => new Request(url, { method: body ? 'POST' : 'GET', headers: { ...(authorized ? { authorization } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
const aiOf = swml => swml.sections.main.find(verb => verb.ai).ai;
const toolUrl = (ai, name) => {
  const url = new URL(ai.SWAIG.functions.find(fn => fn.function === name).web_hook_url || ai.SWAIG.defaults.web_hook_url);
  url.username = ''; url.password = '';
  return url.href;
};
const toolCall = (name, callId, args) => ({ function: name, call_id: callId, argument: { parsed: [args] } });

test('actual prefab preserves all knowledge and Alloy; no fictitious hours or summary callback', async () => {
  const agent = await createLegacyConciergeAgent(options(() => assert.fail('No database access expected')));
  assert.ok(agent instanceof ConciergeAgent);
  const source = knowledgeDocuments.map(doc => doc.text).join('');
  assert.equal(Buffer.byteLength(source), 49340);
  assert.equal(createHash('sha256').update(source).digest('hex'), KNOWLEDGE_SHA256);
  const swml = JSON.parse(agent.renderSwml(randomUUID()));
  const ai = aiOf(swml);
  assert.equal(swml.sections.main.find(verb => verb.answer).answer.max_duration, 60);
  assert.equal(ai.languages.length, 2);
  assert.ok(ai.languages.every(language => language.voice === 'openai.alloy'));
  assert.equal(ai.post_prompt_url, undefined);
  assert.equal(ai.post_prompt, undefined);
  assert.equal(agent.hoursOfOperation.default, undefined);
});

test('HTTP agent enforces existing authentication and rejects Production', async () => {
  const handler = createConciergeFetch({ env, getStore: () => assert.fail('No database access expected') });
  assert.equal((await handler(request(`${origin}${AGENT_ROUTE}`, null, false))).status, 401);
  assert.equal((await handler(request(`${origin}${AGENT_ROUTE}`))).status, 200);
  const production = createConciergeFetch({ env: { ...env, VERCEL_ENV: 'production' } });
  assert.equal((await production(request(`${origin}${AGENT_ROUTE}`))).status, 503);
});

test('knowledge and truthful availability run through signed SDK HTTP tools across instances', async () => {
  const callId = randomUUID();
  const issuer = await createLegacyConciergeAgent(options(() => assert.fail('No database access expected')));
  const receiver = await createLegacyConciergeAgent(options(() => assert.fail('No database access expected')));
  const ai = aiOf(JSON.parse(issuer.renderSwml(callId)));
  const search = await receiver.getApp().fetch(request(toolUrl(ai, 'search_legacy_ai_knowledge'), toolCall('search_legacy_ai_knowledge', callId, { query: 'Custom websites cost $3,500 own site outright after handoff', count: 3 })));
  assert.equal(search.status, 200);
  assert.match((await search.json()).response, /3,500/);
  const availability = await receiver.getApp().fetch(request(toolUrl(ai, 'check_availability'), toolCall('check_availability', callId, { service: 'The Live Booking Calendar', date: '2026-10-06', time: '10:00' })));
  const result = JSON.parse((await availability.json()).response);
  assert.equal(result.available, null);
  assert.equal(result.booked, false);
  const invalid = new URL(toolUrl(ai, 'search_legacy_ai_knowledge')); invalid.searchParams.delete('__token');
  const refused = await receiver.getApp().fetch(request(invalid.href, toolCall('search_legacy_ai_knowledge', callId, { query: 'Legacy AI' })));
  assert.match((await refused.json()).response, /token.*invalid|invalid.*token/i);
});

test('approved request persists once in existing owner-inbox tables; declined approval saves nothing', async t => {
  const client = new PGlite(); t.after(() => client.close());
  await client.exec(await readFile(new URL('../migrations/0000_legacy_crm.sql', import.meta.url), 'utf8'));
  const store = createStore(drizzle(client));
  const agent = await createLegacyConciergeAgent(options(() => store));
  const callId = randomUUID(), ai = aiOf(JSON.parse(agent.renderSwml(callId))), url = toolUrl(ai, 'save_request');
  const args = { name: 'Test caller', email: 'caller@example.test', company: '', request: 'Please discuss a new website and a Tuesday appointment.', approved: false };
  const send = value => agent.getApp().fetch(request(url, toolCall('save_request', callId, value)));
  assert.equal(JSON.parse((await (await send(args)).json()).response).saved, false);
  assert.equal((await store.listInquiries(10)).length, 0);
  const first = JSON.parse((await (await send({ ...args, approved: true })).json()).response);
  const repeat = JSON.parse((await (await send({ ...args, approved: true })).json()).response);
  assert.equal(first.saved, true); assert.equal(first.booked, false); assert.equal(first.emailSent, false);
  assert.equal(first.receipt, repeat.receipt);
  const stored = await store.listInquiries(10);
  assert.equal(stored.length, 1); assert.equal(stored[0].message, args.request);
  assert.equal(stored[0].consent.find(event => event.purpose === 'marketing').choice, 'declined');
});
