import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createInvoiceHandler } from '../lib/invoices.js';
import { signOwnerToken } from '../lib/owner-documents-core.js';
import { OWNER_ADDRESSES } from '../lib/frontdesk.js';

const env = {
  RECEPTIONIST_SESSION_SECRET: 'test-session-secret-at-least24characters',
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
  INVOICE_SECRET: 'invoice-secret',
};
const docId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const post = (body, secret = 'invoice-secret') => new Request('https://legacyai.space/api/frontdesk/invoices', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-frontdesk-secret': secret },
  body: JSON.stringify(body),
});
const token = () => signOwnerToken({ id: docId, scope: 'invoice-reminder', exp: Date.now() + 86400000 }, env.RECEPTIONIST_SESSION_SECRET);
const link = () => `https://legacyai.space/api/frontdesk/invoices?token=${encodeURIComponent(token())}`;
const send = (version, text = 'A friendly reminder that this invoice is due. Please reply if you need a copy.') => new Request(link(), {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token(), action: 'send', version: String(version), text }),
});
async function setup(pg, { kind = 'invoice', status = 'sent', recipient = 'customer@example.com', title = 'Invoice 1001' } = {}) {
  await pg.query(`CREATE TABLE IF NOT EXISTS legacy_owner_documents (id uuid PRIMARY KEY, call_id text NOT NULL, kind text NOT NULL, title text NOT NULL, content text NOT NULL, recipient text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'draft', version integer NOT NULL DEFAULT 1, notified_to text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz)`);
  await pg.query(`INSERT INTO legacy_owner_documents(id,call_id,kind,title,content,recipient,status) VALUES ($1::uuid,'call-1',$2,$3,'Work performed.',$4,$5)`, [docId, kind, title, recipient, status]);
}

test('only a delivered invoice can be registered, once', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const handler = createInvoiceHandler({ getDb: () => db, mail: async () => true, env });
  try {
    await setup(pg, { status: 'draft' });
    assert.equal((await handler(post({ action: 'register', document_id: docId, amount_cents: 10000, due_date: '2026-10-20' }, 'wrong'))).status, 401);
    assert.equal((await handler(post({ action: 'register', document_id: docId, amount_cents: 10000, due_date: '2026-10-20' }))).status, 409);
    await pg.query("UPDATE legacy_owner_documents SET status='sent'");
    assert.equal((await handler(post({ action: 'register', document_id: docId, amount_cents: 0, due_date: '2026-10-20' }))).status, 400);
    assert.equal((await handler(post({ action: 'register', document_id: docId, amount_cents: 10000, due_date: 'soon' }))).status, 400);
    const created = await (await handler(post({ action: 'register', document_id: docId, amount_cents: 10000, due_date: '2026-10-20' }))).json();
    assert.equal(created.status, 'open');
    assert.equal((await handler(post({ action: 'register', document_id: docId, amount_cents: 10000, due_date: '2026-10-20' }))).status, 409);
  } finally { await pg.close(); }
});

test('the chase notifies owners once per week and stops when the invoice is paid', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createInvoiceHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await setup(pg);
    const due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    await handler(post({ action: 'register', document_id: docId, amount_cents: 10000, due_date: due }));
    const first = await (await handler(post({ action: 'chase' }))).json();
    assert.equal(first.pending, 1);
    assert.equal(sent.length, OWNER_ADDRESSES.length);
    assert.match(sent[0].body, /Nothing was sent to a customer/);
    assert.ok(!sent.some(message => message.to === 'customer@example.com'));
    assert.equal((await (await handler(post({ action: 'chase' }))).json()).pending, 0);
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM legacy_invoice_events WHERE event='reminder_due'")).rows[0].n, 1);
    assert.equal((await handler(post({ action: 'paid', document_id: docId }))).status, 200);
    assert.equal((await (await handler(post({ action: 'chase' }))).json()).pending, 0);
  } finally { await pg.close(); }
});

test('the owner approves the exact reminder text before the customer sees it', async () => {
  const pg = new PGlite(); const db = drizzle(pg); const sent = [];
  const handler = createInvoiceHandler({ getDb: () => db, mail: async message => { sent.push(message); return true; }, env });
  try {
    await setup(pg);
    await handler(post({ action: 'register', document_id: docId, amount_cents: 12550, due_date: '2026-10-18' }));
    const page = await handler(new Request(link()));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /\$125\.50/);
    assert.match(html, /Approve and email the customer/);
    const before = sent.length;
    assert.equal((await handler(send(1))).status, 200);
    assert.equal(sent.length, before + 1);
    assert.equal(sent.at(-1).to, 'customer@example.com');
    assert.match(sent.at(-1).body, /friendly reminder/i);
    assert.equal((await handler(send(1))).status, 409);
    const row = (await pg.query('SELECT version,last_reminded_at FROM legacy_invoices')).rows[0];
    assert.equal(row.version, 2);
    assert.ok(row.last_reminded_at);
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM legacy_invoice_events WHERE event='reminder_sent'")).rows[0].n, 1);
  } finally { await pg.close(); }
});

test('a paid invoice shows no reminder form and bad links are refused', async () => {
  const pg = new PGlite(); const db = drizzle(pg);
  const handler = createInvoiceHandler({ getDb: () => db, mail: async () => true, env });
  try {
    await setup(pg);
    await handler(post({ action: 'register', document_id: docId, amount_cents: 5000, due_date: '2026-10-18' }));
    await handler(post({ action: 'paid', document_id: docId }));
    assert.match(await (await handler(new Request(link()))).text(), /already paid|is paid/);
    assert.equal((await handler(new Request('https://legacyai.space/api/frontdesk/invoices?token=bad'))).status, 401);
  } finally { await pg.close(); }
});
