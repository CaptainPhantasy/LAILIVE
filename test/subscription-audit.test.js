import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createSubscriptionAuditHandler, analyzeCharges } from '../lib/subscription-audit.js';
import { signOwnerToken } from '../lib/owner-documents-core.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';
import { parseCSV } from '../dist/contact-health/core.js';

const env = {
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
  SUBSCRIPTION_SECRET: 'sub-secret',
};
const csv = [
  'Date,Description,Amount',
  '2026-01-05,NETFLIX.COM 1234,-15.49',
  '2026-02-05,NETFLIX.COM 5678,-15.49',
  '2026-03-05,NETFLIX.COM 9012,-15.49',
  '2026-01-12,ADOBE SYSTEMS,-59.99',
  '2026-02-12,ADOBE SYSTEMS,-59.99',
  '2025-03-01,NAME-CHEAP-DOMAIN.COM,-12.00',
  '2026-03-01,NAME-CHEAP-DOMAIN.COM,-12.00',
  '2026-01-03,CITY GYM,-40.00',
  '2026-01-12,CITY GYM,-40.00',
  '2026-02-21,CITY GYM,-40.00',
  '2026-02-14,ONE TIME HARDWARE STORE,-88.00',
  '2026-02-15,ADJUSTMENT,0.00',
].join('\n');
const post = (body, secret = 'sub-secret') => new Request('https://legacyai.space/api/frontdesk/subscriptions', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-frontdesk-secret': secret }, body: JSON.stringify(body),
});

test('recurring charges are grouped by inferred cadence and totaled by month', () => {
  const report = analyzeCharges(parseCSV(csv));
  const byName = Object.fromEntries(report.subscriptions.map(item => [item.merchant, item]));
  assert.equal(byName['NETFLIX.COM 9012'].cadence, 'monthly');
  assert.equal(byName['NETFLIX.COM 9012'].average_cents, 1549);
  assert.equal(byName['NETFLIX.COM 9012'].monthly_cents, 1549);
  assert.equal(byName['ADOBE SYSTEMS'].monthly_cents, 5999);
  assert.equal(byName['NAME-CHEAP-DOMAIN.COM'].cadence, 'yearly');
  assert.equal(byName['NAME-CHEAP-DOMAIN.COM'].monthly_cents, 100);
  assert.equal(report.irregular.length, 1);
  assert.equal(report.irregular[0].merchant, 'CITY GYM');
  assert.equal(report.monthly_cents, 1549 + 5999 + 100);
  assert.equal(report.ignored_rows, 1);
  assert.match(report.note, /cancels nothing/);
});

test('the audit is stored, emailed to the owners, and rendered on a signed page', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createSubscriptionAuditHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    assert.equal((await handler(post({ csv }, 'wrong'))).status, 401);
    const created = await (await handler(post({ csv }))).json();
    assert.equal(created.ok, true);
    assert.match(created.id, /^[a-f0-9-]{36}$/);
    assert.equal(created.monthly_cents, 7648);
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.match(sent[0].subject, /\$76\.48 per month/);
    const token = signOwnerToken({ id: created.id, scope: 'subscriptions', exp: Date.now() + 86400000 }, env.RECEPTIONIST_SESSION_SECRET);
    const page = await handler(new Request(`https://legacyai.space/api/frontdesk/subscriptions?token=${encodeURIComponent(token)}`));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /NETFLIX\.COM 9012/);
    assert.match(html, /\$76\.48/);
    assert.match(html, /CITY GYM/);
    assert.equal((await handler(new Request('https://legacyai.space/api/frontdesk/subscriptions?token=bad'))).status, 401);
  } finally { await pg.close(); }
});

test('an unusable file is refused with a plain reason', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const handler = createSubscriptionAuditHandler({ getDb: () => db, mail: async () => true, env });
  try {
    const response = await handler(post({ csv: 'Merchant,Total\nNetflix,15.49\n' }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /date, description, and amount columns/);
  } finally { await pg.close(); }
});
