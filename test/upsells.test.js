import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createUpsellHandler } from '../lib/upsells.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = {
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
  UPSELL_SECRET: 'upsell-secret',
};
const jobUuid = '11111111-1111-4111-8111-111111111111';
const add = (body, secret = 'upsell-secret') => new Request('https://legacyai.space/api/frontdesk/upsells', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-frontdesk-secret': secret }, body: JSON.stringify(body),
});
const linkFrom = text => (text.match(/https:\/\/legacyai\.space\/api\/frontdesk\/upsells\?token=[A-Za-z0-9._-]+/) || [])[0];
const decide = (url, action) => new Request(url, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token: new URL(url).searchParams.get('token'), action }),
});
async function setup(pg) {
  await pg.query('CREATE TABLE legacy_jobs (id uuid PRIMARY KEY, job_id text NOT NULL UNIQUE, customer_name text NOT NULL, service text NOT NULL DEFAULT \'\', address text NOT NULL DEFAULT \'\')');
  await pg.query("INSERT INTO legacy_jobs(id,job_id,customer_name,service,address) VALUES ($1::uuid,'JOB-UP','Pat Customer','Repair','1 Main St')", [jobUuid]);
}

test('an add-on is created for a real job and only the owners are emailed', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createUpsellHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await setup(pg);
    assert.equal((await handler(add({ job_id: 'JOB-UP', name: 'Water heater flush', price_cents: 8900 }, 'wrong'))).status, 401);
    assert.equal((await handler(add({ job_id: 'NO-JOB', name: 'Flush', price_cents: 8900 }))).status, 400);
    assert.equal((await handler(add({ job_id: 'JOB-UP', name: 'Flush', price_cents: 0 }))).status, 400);
    const created = await (await handler(add({ job_id: 'JOB-UP', name: 'Water heater flush', price_cents: 8900, note: 'Unit is 8 years old.' }))).json();
    assert.equal(created.status, 'draft');
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    const url = linkFrom(sent[0].body);
    assert.ok(url);
    const page = await (await handler(new Request(url))).text();
    assert.match(page, /Water heater flush/);
    assert.match(page, /\$89\.00/);
    assert.match(page, /Approve this add-on/);
    assert.match(page, /Unit is 8 years old/);
  } finally { await pg.close(); }
});

test('approving once marks the add-on ready and a second decision does nothing', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createUpsellHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await setup(pg);
    await handler(add({ job_id: 'JOB-UP', name: 'Water heater flush', price_cents: 8900 }));
    const url = linkFrom(sent[0].body);
    const approved = await (await handler(decide(url, 'approve'))).text();
    assert.match(approved, /Offer it when you are ready/);
    assert.equal((await pg.query('SELECT status,approved_at IS NOT NULL AS approved FROM legacy_upsell_offers')).rows[0].status, 'approved');
    assert.equal((await pg.query('SELECT approved_at IS NOT NULL AS approved FROM legacy_upsell_offers')).rows[0].approved, true);
    const before = sent.length;
    const again = await (await handler(decide(url, 'decline'))).text();
    assert.match(again, /already handled/);
    assert.equal(sent.length, before);
    assert.equal((await pg.query('SELECT status FROM legacy_upsell_offers')).rows[0].status, 'approved');
    assert.equal(sent.filter(message => /Approved add-on/.test(message.subject)).length, OWNER_ADDRESSES.length);
  } finally { await pg.close(); }
});

test('declining and invalid links behave correctly', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createUpsellHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await setup(pg);
    await handler(add({ job_id: 'JOB-UP', name: 'Duct cleaning', price_cents: 15000 }));
    const url = linkFrom(sent[0].body);
    assert.match(await (await handler(decide(url, 'decline'))).text(), /Declined/);
    assert.equal((await pg.query('SELECT status FROM legacy_upsell_offers')).rows[0].status, 'declined');
    assert.equal((await handler(new Request('https://legacyai.space/api/frontdesk/upsells?token=bad'))).status, 401);
  } finally { await pg.close(); }
});
