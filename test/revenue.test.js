import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createRevenueHandler } from '../lib/revenue.js';
import { signOwnerToken } from '../lib/owner-documents-core.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = {
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
  REVENUE_SECRET: 'revenue-secret',
};
const jobA = '11111111-1111-4111-8111-111111111111';
const jobB = '22222222-2222-4222-8222-222222222222';
async function seed(pg) {
  await pg.query('CREATE TABLE legacy_jobs (id uuid PRIMARY KEY, job_id text NOT NULL UNIQUE, source text NOT NULL DEFAULT \'\')');
  await pg.query('CREATE TABLE legacy_invoices (document uuid PRIMARY KEY, amount_cents integer NOT NULL, status text NOT NULL, job uuid)');
  await pg.query("INSERT INTO legacy_jobs(id,job_id,source) VALUES ($1::uuid,'JOB-A','Google Ads'),($2::uuid,'JOB-B','')", [jobA, jobB]);
  await pg.query(`INSERT INTO legacy_invoices(document,amount_cents,status,job) VALUES
    ('aaaaaaa1-1111-4111-8111-111111111111',10000,'open',$1::uuid),
    ('aaaaaaa2-2222-4222-8222-222222222222',5000,'paid',$1::uuid),
    ('aaaaaaa3-3333-4333-8333-333333333333',7000,'paid',$2::uuid),
    ('aaaaaaa4-4444-4444-8444-444444444444',2000,'open',NULL)`, [jobA, jobB]);
}
const post = (secret = 'revenue-secret') => new Request('https://legacyai.space/api/frontdesk/revenue', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-frontdesk-secret': secret }, body: '{"action":"report"}',
});
const token = () => signOwnerToken({ scope: 'revenue', exp: Date.now() + 86400000 }, env.RECEPTIONIST_SESSION_SECRET);
const link = () => `https://legacyai.space/api/frontdesk/revenue?token=${encodeURIComponent(token())}`;

test('revenue is grouped by job source and unlinked invoices stay separate', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createRevenueHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await seed(pg);
    const data = await (await handler(post())).json();
    assert.deepEqual(data.sources.map(row => row.source), ['Google Ads', '(no source)']);
    assert.equal(data.sources[0].jobs, 1);
    assert.equal(data.sources[0].invoiced_cents, 15000);
    assert.equal(data.sources[0].paid_cents, 5000);
    assert.equal(data.sources[1].invoiced_cents, 7000);
    assert.equal(data.sources[1].paid_cents, 7000);
    assert.equal(data.unlinked.invoiced_cents, 2000);
    assert.equal(data.unlinked.paid_cents, 0);
    assert.equal(data.totals.jobs, 2);
    assert.equal(data.totals.invoiced_cents, 24000);
    assert.equal(data.totals.paid_cents, 12000);
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.match(sent[0].body, /Ad spend is not included/);
  } finally { await pg.close(); }
});

test('the signed report page renders the same numbers and bad tokens are refused', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const handler = createRevenueHandler({ getDb: () => db, mail: async () => true, env });
  try {
    await seed(pg);
    const page = await handler(new Request(link()));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Where the money came from/);
    assert.match(html, /\$150\.00/);
    assert.match(html, /\$120\.00/);
    assert.match(html, /\(no job linked\)/);
    assert.equal((await handler(new Request('https://legacyai.space/api/frontdesk/revenue?token=bad'))).status, 401);
    assert.equal((await handler(post('wrong'))).status, 401);
  } finally { await pg.close(); }
});
