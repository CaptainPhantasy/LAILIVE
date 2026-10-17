import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createMissedCallLiveHandler, MISSED_CALL_MESSAGE } from '../lib/missed-call-live.js';
import { createFrontdeskSmsHandler } from '../lib/frontdesk-sms.js';

const env = {
  MISSED_CALL_DEMO_ENABLED: 'true', FRONTDESK_CUSTOMER_SMS_ENABLED: 'true',
  MISSED_CALL_WEBHOOK_URL: 'https://demo.example/api/frontdesk/missed-call',
  MISSED_CALL_DEMO_NUMBER: '+18125550100', FRONTDESK_SMS_FROM: '+18125550200',
  SIGNALWIRE_SPACE_HOST: 'example.signalwire.com', SIGNALWIRE_PROJECT_ID: '00000000-0000-4000-8000-000000000001',
  SIGNALWIRE_API_TOKEN: 'test-api-token', SIGNALWIRE_SIGNING_KEY: 'test-signing-key', RECEPTIONIST_WEBHOOK_SECRET: 'test-inbound-secret',
};
const caller = '+18125550300', clock = new Date('2026-10-17T15:00:00Z');
function signed(stage, values = {}, { url, secret = env.SIGNALWIRE_SIGNING_KEY } = {}) {
  const target = url || `${env.MISSED_CALL_WEBHOOK_URL}?stage=${stage}`;
  const body = new URLSearchParams({ AccountSid: env.SIGNALWIRE_PROJECT_ID, CallSid: 'call-1', From: caller,
    To: env.MISSED_CALL_DEMO_NUMBER, Direction: 'inbound', ...values });
  const sorted = [...body].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => k + v).join('');
  return new Request(target, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
    'X-SignalWire-Signature': createHmac('sha1', secret).update(target + sorted).digest('base64') }, body });
}
const accepted = (form, status = 'queued') => Response.json({ sid: 'message-1', status, account_sid: env.SIGNALWIRE_PROJECT_ID,
  from: form.get('From'), to: form.get('To') }, { status: 201 });
async function fixture({ fetcher, config = env, inbox = true, time = () => clock } = {}) {
  const pg = new PGlite(), db = drizzle(pg), sent = [];
  const inbound = createFrontdeskSmsHandler({ getDb: () => db, env: { ...env, FRONTDESK_CUSTOMER_SMS_ENABLED: 'false' }, mail: async () => {} });
  const receive = (body, sid = 'inbound-1', from = caller) => inbound(new Request('https://demo.example/api/frontdesk/sms', {
    method: 'POST', headers: { 'x-frontdesk-secret': env.RECEPTIONIST_WEBHOOK_SECRET },
    body: new URLSearchParams({ MessageSid: sid, From: from, To: env.FRONTDESK_SMS_FROM, Body: body }),
  }));
  if (inbox) assert.equal((await receive('Initialize inbound history', 'init', '+18125550400')).status, 200);
  const dependencies = { getDb: () => db, env: config, now: time, fetcher: fetcher || (async (url, init) => {
    const form = new URLSearchParams(init.body); sent.push({ url, init, form }); return accepted(form);
  }) };
  const handler = createMissedCallLiveHandler(dependencies);
  const prepare = async (values = {}, digits = '1') => {
    assert.equal((await handler(signed('voice', values))).status, 200);
    assert.equal((await handler(signed('consent', { ...values, Digits: digits }))).status, 200);
  };
  const ended = (values = {}) => handler(signed('call-ended', { CallStatus: 'completed', ...values }));
  return { pg, db, sent, handler, prepare, ended, receive, dependencies };
}

test('disabled or invalid configuration never touches storage or sends; both enable flags are required', async () => {
  for (const overrides of [{ MISSED_CALL_DEMO_ENABLED: undefined }, { FRONTDESK_CUSTOMER_SMS_ENABLED: undefined },
    { SIGNALWIRE_SIGNING_KEY: undefined }, { SIGNALWIRE_SPACE_HOST: 'attacker.example' },
    { MISSED_CALL_WEBHOOK_URL: 'http://demo.example/api/frontdesk/missed-call' }]) {
    const handler = createMissedCallLiveHandler({ env: { ...env, ...overrides },
      getDb: () => assert.fail('disabled handler accessed storage'), fetcher: () => assert.fail('disabled handler sent SMS') });
    assert.equal((await handler(signed('voice'))).status, 503);
  }
});

test('real SDK validates the complete form and canonical URL before any database access', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.handler(signed('voice', {}, { secret: 'wrong' }))).status, 401);
    const original = signed('consent', { Digits: '0' });
    const changed = new Request(original.url, { method: 'POST', headers: original.headers, body: (await original.text()).replace('Digits=0', 'Digits=1') });
    assert.equal((await f.handler(changed)).status, 401);
    const emptySignature = createHmac('sha1', env.SIGNALWIRE_SIGNING_KEY).update(original.url).digest('base64');
    assert.equal((await f.handler(new Request(original.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
      'X-SignalWire-Signature': emptySignature }, body: new URLSearchParams({ AccountSid: env.SIGNALWIRE_PROJECT_ID, Digits: '1' }) }))).status, 401);
    assert.equal((await f.handler(signed('voice', { AccountSid: 'wrong-project' }))).status, 400);
    assert.equal((await f.handler(signed('voice', { To: '+18125550999' }))).status, 400);
    assert.equal((await f.handler(signed('voice', {}, { url: 'https://wrong.example/api/frontdesk/missed-call?stage=voice' }))).status, 401);
    assert.equal((await f.handler(new Request(env.MISSED_CALL_WEBHOOK_URL))).status, 405);
    assert.equal(f.sent.length, 0);
    assert.equal((await f.pg.query("SELECT to_regclass('legacy_missed_call_demo') AS name")).rows[0].name, null);
  } finally { await f.pg.close(); }
});

test('signed consent plus completed call sends exactly one API request to the actual caller, persisted across handler restarts', async () => {
  let release, started, requests = 0;
  const waiting = new Promise(resolve => { release = resolve; }), dispatching = new Promise(resolve => { started = resolve; });
  const f = await fixture({ fetcher: async (url, init) => {
    requests++; const form = new URLSearchParams(init.body);
    assert.equal(url, `https://${env.SIGNALWIRE_SPACE_HOST}/api/laml/2010-04-01/Accounts/${env.SIGNALWIRE_PROJECT_ID}/Messages.json`);
    assert.equal(form.get('To'), caller); assert.equal(form.get('From'), env.FRONTDESK_SMS_FROM);
    assert.equal(form.get('Body'), MISSED_CALL_MESSAGE); assert.equal(form.get('MaxPrice'), '0.02');
    assert.equal(init.redirect, 'error');
    started(); await waiting; return accepted(form);
  } });
  try {
    const greeting = await f.handler(signed('voice'));
    assert.match(await greeting.text(), /Press 1 to request one automated demo text/);
    assert.equal(requests, 0);
    await f.handler(signed('consent', { Digits: '1' })); assert.equal(requests, 0);
    const first = f.ended(); await dispatching;
    const restarted = createMissedCallLiveHandler(f.dependencies);
    assert.equal((await restarted(signed('call-ended', { CallStatus: 'completed' }))).status, 200);
    assert.equal(requests, 1); release(); assert.equal((await first).status, 200);
    await restarted(signed('call-ended', { CallStatus: 'completed' })); assert.equal(requests, 1);
    const row = (await f.pg.query('SELECT * FROM legacy_missed_call_demo')).rows[0];
    assert.ok(row.consent_at); assert.ok(row.ended_at); assert.ok(row.attempt_at);
    assert.equal(row.dispatch_state, 'accepted'); assert.equal(row.message_status, 'queued');
  } finally { release?.(); await f.pg.close(); }
});

test('no consent, wrong digit, failed call and unknown call never send', async () => {
  const f = await fixture();
  try {
    await f.ended({ CallSid: 'unknown' });
    await f.handler(signed('voice', { CallSid: 'no-consent' })); await f.ended({ CallSid: 'no-consent' });
    await f.prepare({ CallSid: 'wrong-digit' }, '2'); await f.ended({ CallSid: 'wrong-digit' });
    await f.prepare({ CallSid: 'failed' }); await f.ended({ CallSid: 'failed', CallStatus: 'failed' });
    assert.equal(f.sent.length, 0);
    const rows = (await f.pg.query('SELECT suppression_reason FROM legacy_missed_call_demo ORDER BY call_id')).rows;
    assert.deepEqual(rows.map(row => row.suppression_reason), ['call_failed', 'no_consent', 'no_consent']);
    assert.equal((await f.handler(signed('consent', { CallSid: 'no-consent', Digits: '1' }))).status, 200);
    await f.ended({ CallSid: 'no-consent' }); assert.equal(f.sent.length, 0);
  } finally { await f.pg.close(); }
});

test('stored STOP is honored after consent and START allows only a fresh call; missing inbox fails closed', async () => {
  const f = await fixture();
  try {
    await f.prepare(); await f.receive(' STOP ', 'stop-1'); await f.ended();
    assert.equal(f.sent.length, 0);
    assert.equal((await f.pg.query('SELECT suppression_reason FROM legacy_missed_call_demo')).rows[0].suppression_reason, 'opted_out');
    const stopped = await f.handler(signed('voice', { CallSid: 'still-stopped' }));
    assert.match(await stopped.text(), /opted out/);
    await f.receive('START', 'start-1');
    await f.pg.query("UPDATE legacy_frontdesk_sms SET received_at=received_at + interval '1 second' WHERE message_id='start-1'");
    await f.prepare({ CallSid: 'fresh' }); await f.ended({ CallSid: 'fresh' });
    assert.equal(f.sent.length, 1);
    await f.ended(); assert.equal(f.sent.length, 1);
  } finally { await f.pg.close(); }
  const noInbox = await fixture({ inbox: false });
  try {
    assert.equal((await noInbox.handler(signed('voice'))).status, 503);
    assert.equal(noInbox.sent.length, 0);
  } finally { await noInbox.pg.close(); }
});

test('durable quotas serialize different calls from one caller and cap all callers at 20 per rolling day', async () => {
  const f = await fixture();
  try {
    await f.prepare({ CallSid: 'first' }); await f.prepare({ CallSid: 'second' });
    const responses = await Promise.all([f.ended({ CallSid: 'first' }), f.ended({ CallSid: 'second' })]);
    assert.ok(responses.every(response => response.status === 200)); assert.equal(f.sent.length, 1);
    assert.equal((await f.pg.query("SELECT count(*) AS count FROM legacy_missed_call_demo WHERE suppression_reason='caller_limit'")).rows[0].count, 1);
    await f.pg.query(`INSERT INTO legacy_missed_call_demo(call_id,caller,demo_number,sms_from,disclosure_version,created_at,updated_at,attempt_at,dispatch_state)
      SELECT 'seed-' || x, '+1812555' || lpad(x::text,4,'0'), $1, $2, 'test', $3, $3, $3, 'unknown' FROM generate_series(1,19) x`,
    [env.MISSED_CALL_DEMO_NUMBER, env.FRONTDESK_SMS_FROM, clock.toISOString()]);
    const next = { CallSid: 'over-global-limit', From: '+18125550800' };
    await f.prepare(next); await f.ended(next); assert.equal(f.sent.length, 1);
    assert.equal((await f.pg.query("SELECT suppression_reason FROM legacy_missed_call_demo WHERE call_id='over-global-limit'")).rows[0].suppression_reason, 'global_limit');
  } finally { await f.pg.close(); }
});

test('uncertain POST outcomes are never retried, and a later authenticated delivery callback resolves the record', async () => {
  let requests = 0, statusUrl;
  const f = await fixture({ fetcher: async (_url, init) => {
    requests++; statusUrl = new URLSearchParams(init.body).get('StatusCallback'); throw new Error('connection closed after write');
  } });
  try {
    await f.prepare(); assert.equal((await f.ended()).status, 200); await f.ended(); assert.equal(requests, 1);
    assert.equal((await f.pg.query('SELECT dispatch_state FROM legacy_missed_call_demo')).rows[0].dispatch_state, 'unknown');
    const values = { MessageSid: 'actual-message', MessageStatus: 'delivered', From: env.FRONTDESK_SMS_FROM, To: caller };
    const disabled = createMissedCallLiveHandler({ ...f.dependencies, env: { ...env, MISSED_CALL_DEMO_ENABLED: 'false' } });
    assert.equal((await disabled(signed('message-status', { ...values, MessageStatus: 'constructor' }, { url: statusUrl }))).status, 400);
    assert.equal((await disabled(signed('message-status', values, { url: statusUrl }))).status, 200);
    await disabled(signed('message-status', { ...values, MessageStatus: 'queued' }, { url: statusUrl }));
    await disabled(signed('message-status', { ...values, MessageSid: 'unrelated-message' }, { url: statusUrl }));
    const row = (await f.pg.query('SELECT * FROM legacy_missed_call_demo')).rows[0];
    assert.equal(row.dispatch_state, 'accepted'); assert.equal(row.message_id, 'actual-message'); assert.equal(row.message_status, 'delivered');
    assert.equal((await disabled(signed('message-status', { ...values, To: '+18125550999' }, { url: statusUrl }))).status, 400);
    assert.equal(requests, 1);
  } finally { await f.pg.close(); }
});

test('delivery callback arriving before the API response is retained without status regression', async () => {
  let f;
  f = await fixture({ fetcher: async (_url, init) => {
    const form = new URLSearchParams(init.body);
    const result = await f.handler(signed('message-status', { MessageSid: 'message-1', MessageStatus: 'delivered',
      From: env.FRONTDESK_SMS_FROM, To: caller }, { url: form.get('StatusCallback') }));
    assert.equal(result.status, 200); return accepted(form);
  } });
  try {
    await f.prepare(); assert.equal((await f.ended()).status, 200);
    const row = (await f.pg.query('SELECT * FROM legacy_missed_call_demo')).rows[0];
    assert.equal(row.message_status, 'delivered'); assert.equal(row.dispatch_state, 'accepted');
  } finally { await f.pg.close(); }
});

test('expired consent and call identity changes cannot trigger a send', async () => {
  let time = clock;
  const f = await fixture({ time: () => time });
  try {
    await f.prepare();
    assert.equal((await f.ended({ From: '+18125550999' })).status, 409);
    time = new Date(clock.getTime() + 16 * 60000); await f.ended();
    assert.equal(f.sent.length, 0);
    assert.equal((await f.pg.query('SELECT suppression_reason FROM legacy_missed_call_demo')).rows[0].suppression_reason, 'consent_expired');
  } finally { await f.pg.close(); }
});
