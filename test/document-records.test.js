import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { draftItemsSchema, ensureQuoteInquiryRecord, itemsTotalCents, net7Due, nextReference, registerDraftInvoice } from '../lib/document-records.js';
import { ensureInvoiceSchema } from '../lib/invoices.js';
import { catalog } from '../lib/concierge/contracts.js';

test('money math is exact through string arithmetic, never floating multiplication', () => {
  assert.equal(itemsTotalCents([{ description: 'Labor', qty: '4', unit_price: '19.99' }]), 7996);
  assert.equal(itemsTotalCents([{ description: 'Half day', qty: '0.5', unit_price: '19.99' }]), 1000);
  assert.equal(itemsTotalCents([{ description: 'Big job', qty: '2', unit_price: '12345.67' }]), 2469134);
  assert.equal(itemsTotalCents([{ description: 'A', qty: '4', unit_price: '19.99' }, { description: 'B', qty: '0.5', unit_price: '12345.67' }]), 4 * 1999 + 617284);
  assert.equal(itemsTotalCents([{ description: 'Numbers too', qty: 4, unit_price: 19.99 }]), 7996, 'number forms normalize through String()');
  assert.equal(itemsTotalCents([]), 0);
  assert.equal(itemsTotalCents([{ description: 'x', qty: '1e3', unit_price: '19.99' }]), 1999000, 'the schema is the gate; the sum tolerates without throwing');
  assert.equal(itemsTotalCents([{ description: 'Half-cent boundary', qty: '0.29', unit_price: '0.50' }]), 15, '0.29 x $0.50 rounds half-up exactly (14.5 -> 15), never float-rounded');
  assert.equal(itemsTotalCents([{ description: 'Tenth of a cent', qty: '1', unit_price: '19.99' }]), 1999, 'two-decimal prices stay exact');
});

test('net7Due adds seven calendar days in the owner time zone', () => {
  assert.equal(net7Due(new Date('2026-11-20T18:00:00Z')), '2026-11-27', 'field map sample: issued November 20, due November 27');
  assert.equal(net7Due(new Date('2026-03-07T03:00:00Z')), '2026-03-13', 'issued March 6 local (10 pm ET); crosses the DST start without shifting a day');
  assert.equal(net7Due(new Date('2026-01-31T05:00:00Z')), '2026-02-07');
});

test('item payloads are strictly validated and normalized to plain decimals', () => {
  const parsed = draftItemsSchema.parse([{ description: '  Labor  ', qty: 4, unit_price: 19.99 }]);
  assert.deepEqual(parsed, [{ description: 'Labor', qty: '4', unit_price: '19.99' }]);
  for (const bad of [
    [{ description: 'x', qty: '1e3', unit_price: '2.00' }],
    [{ description: 'x', qty: '1', unit_price: '2.005' }],
    [{ description: 'x', qty: '1', unit_price: '-2.00' }],
    [{ description: 'x', qty: '1', unit_price: '2.00', tax: 0 }],
    [{ description: '', qty: '1', unit_price: '2.00' }],
    [{ description: 'x'.repeat(201), qty: '1', unit_price: '2.00' }],
    Array.from({ length: 51 }, (_, i) => ({ description: `item ${i}`, qty: '1', unit_price: '1.00' })),
    [],
    'not an array',
  ]) assert.throws(() => draftItemsSchema.parse(bad), JSON.stringify(bad)?.slice(0, 40));
});

test('references sequence per kind from Q-001 and INV-001, monotonic under concurrency', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  try {
    assert.equal(await nextReference(db, 'quote'), 'Q-001');
    assert.equal(await nextReference(db, 'quote'), 'Q-002');
    assert.equal(await nextReference(db, 'invoice'), 'INV-001', 'kinds sequence independently');
    const concurrent = await Promise.all([nextReference(db, 'quote'), nextReference(db, 'quote'), nextReference(db, 'quote'), nextReference(db, 'quote')]);
    assert.deepEqual(concurrent.map(reference => Number(reference.slice(2))).sort((a, b) => a - b), [3, 4, 5, 6], 'each concurrent approval advances the counter exactly once');
  } finally { await pg.close(); }
});

test('quote inquiries are idempotent on replay and reuse a contact by email', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  try {
    await pg.query(`CREATE TABLE IF NOT EXISTS legacy_consent_events (id uuid PRIMARY KEY, inquiry_id uuid, contact_id uuid, purpose text, channel text, choice text, notice_version text, notice_text text, action text, created_at timestamptz NOT NULL DEFAULT now())`);
    const first = await ensureQuoteInquiryRecord(db, { sourceId: 'document-one', email: 'customer@example.com', message: 'Kitchen quote\nFull text' });
    const replay = await ensureQuoteInquiryRecord(db, { sourceId: 'document-one', email: 'customer@example.com', message: 'Kitchen quote\nFull text' });
    assert.equal(replay.inquiryId, first.inquiryId);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_inquiries')).rows[0].n, 1);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_contacts')).rows[0].n, 1);
    const second = await ensureQuoteInquiryRecord(db, { sourceId: 'document-two', email: 'customer@example.com', message: 'Second quote' });
    assert.notEqual(second.inquiryId, first.inquiryId, 'a new source id is a new inquiry');
    assert.equal(second.contactId, first.contactId, 'the contact is reused by exact email');
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_contacts')).rows[0].n, 1);
    const inquiry = (await pg.query('SELECT id,contact_id,message,catalog_version,status FROM legacy_inquiries ORDER BY created_at')).rows[0];
    assert.equal(inquiry.message, 'Kitchen quote\nFull text');
    assert.equal(inquiry.catalog_version, catalog.version);
    assert.equal(inquiry.status, 'received');
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_consent_events')).rows[0].n, 0, 'no consent events are fabricated');
  } finally { await pg.close(); }
});

test('dictated invoices register through the one insert path; prose-only drafts register nothing', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  try {
    await ensureInvoiceSchema(db);
    const skipped = await registerDraftInvoice(db, { document: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', items: null });
    assert.deepEqual(skipped, { registered: false, reason: 'no-items' });
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM legacy_invoices')).rows[0].n, 0);
    const document = '11111111-2222-4333-8444-555555555555';
    const registered = await registerDraftInvoice(db, { document, items: [{ description: 'Labor', qty: '4', unit_price: '85.00' }, { description: 'Parts', qty: '2', unit_price: '19.99' }] });
    assert.equal(registered.registered, true);
    assert.equal(registered.amount_cents, 4 * 8500 + 2 * 1999);
    assert.equal(registered.due_date, net7Due(new Date()), 'Net 7 from the approval day');
    const row = (await pg.query('SELECT amount_cents,due_date::text AS due,status FROM legacy_invoices WHERE document=$1::uuid', [document])).rows[0];
    assert.equal(row.amount_cents, 37998);
    assert.equal(row.status, 'open');
    const replay = await registerDraftInvoice(db, { document, items: [{ description: 'Labor', qty: '4', unit_price: '85.00' }, { description: 'Parts', qty: '2', unit_price: '19.99' }] });
    assert.equal(replay.registered, false, 'replays never double-register');
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM legacy_invoice_events WHERE event='registered'")).rows[0].n, 1);
  } finally { await pg.close(); }
});
