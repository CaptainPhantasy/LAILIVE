import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createFrontdeskSmsHandler } from '../lib/frontdesk-sms.js';
const env = { RECEPTIONIST_WEBHOOK_SECRET: 'test-secret', FRONTDESK_SMS_FROM: '+18124123454' };
const request = (values = {}, secret = true) => new Request('https://legacyai.space/api/frontdesk/sms', { method: 'POST', headers: { ...(secret ? { 'x-frontdesk-secret': 'test-secret' } : {}) }, body: new URLSearchParams({ MessageSid: 'SM123', From: '+18125550123', To: env.FRONTDESK_SMS_FROM, Body: 'Please help with my website', ...values }) });
test('real database saves inbound lead once and sends only owner emails while outbound registration disabled', async () => {
 const pg = new PGlite(); const sent = [];
 try {
  const handler = createFrontdeskSmsHandler({ getDb: () => drizzle(pg), env, mail: async value => sent.push(value) });
  assert.equal((await handler(request({}, false))).status, 401);
  assert.equal((await handler(request({ To: '+19999999999' }))).status, 400);
  const response = await handler(request()); assert.equal(response.status, 200); assert.ok(!(await response.text()).includes('<Message>'));
  assert.equal(sent.length, 2); assert.ok(sent.every(x => x.to !== '+18125550123'));
  assert.equal((await handler(request())).status, 200); assert.equal(sent.length, 2);
  const result = await pg.query('SELECT * FROM legacy_frontdesk_sms'); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].body, 'Please help with my website');
 } finally { await pg.close(); }
});

test('a retry cannot acknowledge an inbound text while owner notification is still pending', async () => {
 const pg = new PGlite(); let release, started;
 const blocked = new Promise(resolve => { release = resolve; }), sending = new Promise(resolve => { started = resolve; });
 try {
  const handler = createFrontdeskSmsHandler({ getDb: () => drizzle(pg), env, mail: async () => { started(); await blocked; } });
  const first = handler(request());
  await sending;
  const retry = await handler(request());
  assert.equal(retry.status, 503);
  assert.match((await retry.json()).error, /pending/);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await handler(request())).status, 200);
 } finally { release?.(); await pg.close(); }
});

test('enabled replies honor persisted STOP, REVOKE and OPT OUT across handlers without blocking other senders', async () => {
 const pg = new PGlite(), db = drizzle(pg), delivered = [];
 const enabled = { ...env, FRONTDESK_CUSTOMER_SMS_ENABLED: 'true' };
 const create = () => createFrontdeskSmsHandler({ getDb: () => db, env: enabled, mail: async value => delivered.push(value) });
 try {
  let handler = create();
  const first = await handler(request({ MessageSid: 'ordinary-first' }));
  assert.match(await first.text(), /<Message>/);
  for (const [index, keyword] of [' StOp ', 'REVOKE', 'OPT OUT'].entries()) {
   const from = `+1812555012${index}`;
   const control = await handler(request({ MessageSid: `control-${index}`, From: from, Body: keyword }));
   assert.equal(control.status, 200); assert.doesNotMatch(await control.text(), /<Message>/);
   handler = create();
   const later = await handler(request({ MessageSid: `later-${index}`, From: from, Body: 'Please help me with another question' }));
   assert.equal(later.status, 200); assert.doesNotMatch(await later.text(), /<Message>/);
  }
  const unaffected = await handler(request({ MessageSid: 'other-sender', From: '+18125550999' }));
  assert.match(await unaffected.text(), /<Message>/);
  assert.equal(delivered.length, 16); // All 8 incoming messages still reach both owner inboxes.
 } finally { await pg.close(); }
});

test('only later START or UNSTOP restores replies; replaying an old START cannot undo a newer STOP', async () => {
 const pg = new PGlite(), db = drizzle(pg);
 const handler = createFrontdeskSmsHandler({ getDb: () => db, env: { ...env, FRONTDESK_CUSTOMER_SMS_ENABLED: 'true' }, mail: async () => {} });
 const receive = (sid, body) => handler(request({ MessageSid: sid, Body: body }));
 try {
  await receive('stop-1', 'STOP');
  const yes = await receive('ordinary-yes', 'Yes'); assert.doesNotMatch(await yes.text(), /<Message>/);
  const start = await receive('start-1', 'START'); assert.doesNotMatch(await start.text(), /<Message>/);
  const restored = await receive('restored-1', 'Please help'); assert.match(await restored.text(), /<Message>/);
  await receive('stop-2', 'STOP');
  await receive('start-1', 'START'); // Duplicate provider webhook, original receipt time remains.
  const blocked = await receive('still-stopped', 'Please help'); assert.doesNotMatch(await blocked.text(), /<Message>/);
  const unstop = await receive('unstop-1', 'UNSTOP'); assert.doesNotMatch(await unstop.text(), /<Message>/);
  const restoredAgain = await receive('restored-2', 'Another question'); assert.match(await restoredAgain.text(), /<Message>/);
 } finally { await pg.close(); }
});

test('STOP saved before a failed owner email still suppresses subsequent replies', async () => {
 const pg = new PGlite(), db = drizzle(pg);
 const handler = createFrontdeskSmsHandler({ getDb: () => db, env: { ...env, FRONTDESK_CUSTOMER_SMS_ENABLED: 'true' }, mail: async value => {
  if (value.body.includes('Message id: failed-stop')) throw new Error('owner webhook unavailable');
 } });
 try {
  assert.equal((await handler(request({ MessageSid: 'failed-stop', Body: 'STOP' }))).status, 503);
  const next = await handler(request({ MessageSid: 'after-failed-stop', Body: 'Here is more detail' }));
  assert.equal(next.status, 200); assert.doesNotMatch(await next.text(), /<Message>/);
  const row = (await pg.query("SELECT emailed,body FROM legacy_frontdesk_sms WHERE message_id='failed-stop'")).rows[0];
  assert.equal(row.emailed, false); assert.equal(row.body, 'STOP');
 } finally { await pg.close(); }
});

test('STOP arriving while an earlier message is waiting for owner email suppresses the earlier reply', async () => {
 const pg = new PGlite(), db = drizzle(pg); let release, started;
 const pending = new Promise(resolve => { release = resolve; }), sending = new Promise(resolve => { started = resolve; });
 const handler = createFrontdeskSmsHandler({ getDb: () => db, env: { ...env, FRONTDESK_CUSTOMER_SMS_ENABLED: 'true' }, mail: async value => {
  if (value.body.includes('Message id: slow-message')) { started(); await pending; }
 } });
 try {
  const first = handler(request({ MessageSid: 'slow-message' })); await sending;
  const stop = await handler(request({ MessageSid: 'stop-during-email', Body: 'STOP' }));
  assert.equal(stop.status, 200); assert.doesNotMatch(await stop.text(), /<Message>/);
  release();
  const response = await first; assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /<Message>/);
 } finally { release?.(); await pg.close(); }
});
