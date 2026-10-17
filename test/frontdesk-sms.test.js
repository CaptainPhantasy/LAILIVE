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
