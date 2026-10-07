import test from 'node:test';
import assert from 'node:assert/strict';
import { createConciergeFetch, AGENT_ROUTE } from '../lib/receptionist-concierge.js';

test('private authentication reasons match SDK outcomes and expose only fixed codes and generated correlation/time', async () => {
  const origin = 'https://preview.example.test';
  const password = 'synthetic:@/%&+?= #é🦉-never-log-this';
  const env = { VERCEL_ENV: 'preview', RECEPTIONIST_SIGNALWIRE_ENABLED: 'true', RECEPTIONIST_PREVIEW_ORIGIN: origin, RECEPTIONIST_WEBHOOK_SECRET: password, RECEPTIONIST_SESSION_SECRET: 'synthetic-session-'.repeat(4) };
  const events = [];
  const fetch = createConciergeFetch({ env, getStore: () => assert.fail('No store access expected'), authDiagnostic: event => events.push(event) });
  const basic = (username, value) => `Basic ${Buffer.from(`${username}:${value}`).toString('base64')}`;
  const cases = [
    [undefined, 'missing_authorization'],
    ['', 'missing_authorization'],
    ['Bearer synthetic-never-log-this', 'unsupported_scheme'],
    ['Basic', 'malformed_basic'],
    ['Basic ###', 'malformed_basic'],
    ['Basic YQ===', 'malformed_basic'],
    [`Basic ${Buffer.from('no-colon').toString('base64')}`, 'malformed_basic'],
    [basic('signalwire', password), 'username_mismatch'],
    [basic('receptionist', 'synthetic-wrong-password'), 'password_mismatch'],
    [basic('receptionist', encodeURIComponent(password)), 'password_mismatch'],
    [basic('receptionist', password), 'accepted'],
    [basic('receptionist', password).replace('Basic ', 'basic '), 'accepted'],
  ];
  const body = JSON.stringify({ call: { call_id: '11111111-2222-4333-8444-555555555555' }, note: 'synthetic-body-must-never-be-logged' });
  const rejectedBodies = [];
  for (const [authorization, reason] of cases) {
    const response = await fetch(new Request(`${origin}${AGENT_ROUTE}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }) }, body }));
    assert.equal(response.status, reason === 'accepted' ? 200 : 401);
    if (reason !== 'accepted') {
      rejectedBodies.push(await response.text());
      assert.match(response.headers.get('www-authenticate'), /^Basic /);
    } else {
      const swml = await response.json();
      const ai = swml.sections.main.find(operation => operation.ai).ai;
      assert.equal(ai.languages[0].voice, 'openai.alloy');
      assert.ok(ai.SWAIG.functions.some(fn => fn.function === 'save_request'));
    }
    const event = events.at(-1);
    assert.deepEqual(Object.keys(event).sort(), ['correlation', 'reason', 'time']);
    assert.equal(event.reason, reason);
    assert.match(event.correlation, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(new Date(event.time).toISOString(), event.time);
  }
  assert.equal(events.length, cases.length);
  assert.equal(new Set(events.map(event => event.correlation)).size, cases.length);
  assert.ok(rejectedBodies.every(body => body === '{"error":"Unauthorized"}'));
  const output = JSON.stringify(events);
  for (const forbidden of [password, encodeURIComponent(password), 'never-log-this', 'synthetic-body', '11111111-2222-4333-8444-555555555555']) assert.ok(!output.includes(forbidden));

  const brokenDiagnostic = createConciergeFetch({ env, authDiagnostic: () => { throw new Error('synthetic diagnostic failure'); } });
  const response = await brokenDiagnostic(new Request(`${origin}${AGENT_ROUTE}`));
  assert.equal(response.status, 401);
  assert.equal(await response.text(), '{"error":"Unauthorized"}');
});
