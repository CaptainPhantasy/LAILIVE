import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES, frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { signOwnerToken, readOwnerToken } from './owner-documents-core.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = cents => `$${(Number(cents) / 100).toFixed(2)}`;
const page = (html, status = 200) => new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legacy AI invoice reminder</title><style>body{font:18px system-ui;max-width:720px;margin:24px auto;padding:16px}h1{font-size:1.4em}textarea{box-sizing:border-box;width:100%;min-height:180px;font:16px system-ui}button{display:block;width:100%;box-sizing:border-box;padding:16px;margin:10px 0;font:18px system-ui;border-radius:8px;border:1px solid #ccc;background:#fff}p{overflow-wrap:anywhere}</style>${html}</html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });

// Invoicing stays manual: this records an amount and due date for an invoice the
// owner already delivered, nudges the owner when it is due, and sends a customer
// reminder only after the owner approves the exact text.

// One schema path and one insert path for every legacy_invoices row, so the
// secret-gated register action and the owner-draft approval hook cannot drift.
export async function ensureInvoiceSchema(db) {
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_invoices (document uuid PRIMARY KEY, amount_cents integer NOT NULL, due_date date NOT NULL, status text NOT NULL DEFAULT 'open', paid_at timestamptz, last_reminded_at timestamptz, last_due_notice_at timestamptz, job uuid, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now())`));
  await db.execute(sql.raw('ALTER TABLE legacy_invoices ADD COLUMN IF NOT EXISTS job uuid'));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_invoice_events (id bigserial PRIMARY KEY, document uuid NOT NULL, event text NOT NULL, detail text, created_at timestamptz NOT NULL DEFAULT now())`));
  for (const table of ['legacy_invoices', 'legacy_invoice_events']) await db.execute(sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
}

const recordEvent = async (db, id, name, detail = null) => { try { await db.execute(sql`INSERT INTO legacy_invoice_events(document,event,detail) VALUES (${id}::uuid,${name},${detail})`); } catch { /* receipts must not block the action */ } };

// Creates the open legacy_invoices row for an owner document. Throws an Error
// carrying `status` (400) with the register action's exact message when the
// amount, due date, or job id is invalid; returns { registered: false } when a
// row already exists so replays stay idempotent, never double-registering.
export async function createInvoiceRecord(db, { document, amount_cents, due_date, job_id }) {
  await ensureInvoiceSchema(db);
  const amount = Number(amount_cents), due = bounded(due_date, 10);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000000) throw Object.assign(new Error('A positive amount in cents is required.'), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(due))) throw Object.assign(new Error('A due date is required.'), { status: 400 });
  if ((await db.execute(sql`SELECT * FROM legacy_invoices WHERE document=${document}::uuid`)).rows[0]) return { registered: false };
  let job = null;
  if (job_id) {
    const jobId = bounded(job_id, 64);
    const found = (await db.execute(sql`SELECT id FROM legacy_jobs WHERE job_id=${jobId}`)).rows[0];
    if (!found) throw Object.assign(new Error('No job matches that job id.'), { status: 400 });
    job = found.id;
  }
  const inserted = await db.execute(sql`INSERT INTO legacy_invoices(document,amount_cents,due_date,status,job) VALUES (${document}::uuid,${amount},${due}::date,'open',${job}::uuid) ON CONFLICT (document) DO NOTHING RETURNING document`);
  if (!inserted.rows.length) return { registered: false };
  await recordEvent(db, document, 'registered', `${amount}:${due}`);
  return { registered: true, amount_cents: amount, due_date: due, job_id: job ? String(job) : null };
}

export function createInvoiceHandler({ getDb, mail, env = process.env, now = Date.now } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => { await ensureInvoiceSchema(db()); })().catch(error => { ready = null; throw error; });
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const reminderLink = id => `${origin()}/api/frontdesk/invoices?token=${signOwnerToken({ id, scope: 'invoice-reminder', exp: now() + 14 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET)}`;
  const getDoc = async id => (await db().execute(sql`SELECT * FROM legacy_owner_documents WHERE id=${id}::uuid`)).rows[0];
  const getInvoice = async id => (await db().execute(sql`SELECT * FROM legacy_invoices WHERE document=${id}::uuid`)).rows[0];
  const event = (id, name, detail = null) => recordEvent(db(), id, name, detail);
  const defaultText = (doc, invoice) => `A friendly reminder that invoice ${doc.title} for ${money(invoice.amount_cents)} was due ${invoice.due_date}.\n\nIf it is already handled, thank you — please ignore this note. Otherwise, reply to this email and we will help.\n\nDouglas, Legacy AI`;
  const approvedPage = (doc, invoice, message = '') => page(`<h1>${esc(doc.title)}</h1>${message ? `<p><b>${esc(message)}</b></p>` : ''}<p>${money(invoice.amount_cents)} · due ${esc(invoice.due_date)} · ${esc(invoice.status)}</p>`);
  const reminderPage = (doc, invoice, text, tokenValue) => page(`<h1>Remind ${esc(doc.title)}</h1><p>${money(invoice.amount_cents)} · due ${esc(invoice.due_date)}</p>
    <form method="post" action="?token=${encodeURIComponent(tokenValue)}"><input type="hidden" name="token" value="${esc(tokenValue)}"><input type="hidden" name="version" value="${invoice.version}"><input type="hidden" name="action" value="send">
    <textarea name="text" maxlength="4000">${esc(text)}</textarea><button>Approve and email the customer</button></form>
    <p><small>The customer sees exactly this text. Nothing is sent until you approve. No payment is taken.</small></p>`);

  async function chase() {
    const cutoff = new Date(now() + 3 * 86400000).toISOString().slice(0, 10);
    const candidates = (await db().execute(sql`SELECT i.*, d.title, d.recipient FROM legacy_invoices i JOIN legacy_owner_documents d ON d.id=i.document
      WHERE i.status='open' AND i.due_date <= ${cutoff} AND d.recipient <> ''
        AND (i.last_due_notice_at IS NULL OR i.last_due_notice_at < now() - interval '7 days')
      ORDER BY i.due_date ASC LIMIT 50`)).rows;
    const rows = [];
    for (const row of candidates) {
      const claimed = await db().execute(sql`UPDATE legacy_invoices SET last_due_notice_at=now() WHERE document=${row.document}::uuid AND status='open' AND (last_due_notice_at IS NULL OR last_due_notice_at < now() - interval '7 days') RETURNING document`);
      if (claimed.rows.length) rows.push(row);
    }
    if (!rows.length) return { pending: 0 };
    for (const row of rows) await event(row.document, 'reminder_due', String(row.due_date));
    const lines = rows.map((row, index) => `${index + 1}. ${row.title} — ${money(row.amount_cents)} — due ${row.due_date}`).join('\n');
    try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `${rows.length} invoice${rows.length === 1 ? '' : 's'} due soon`, body: `These invoices are due within three days or overdue:\n\n${lines}\n\nOpen each reminder to approve the exact customer text:\n${rows.map(row => reminderLink(row.document)).join('\n')}\n\nNothing was sent to a customer.` }))); } catch { /* the due receipts are recorded even when mail fails */ }
    return { pending: rows.length };
  }

  async function approveReminder(id, text, version) {
    const doc = await getDoc(id), invoice = await getInvoice(id);
    if (!doc || !invoice) return { error: 'Invoice not found.', status: 404 };
    if (invoice.status === 'paid') return { error: 'This invoice is already paid.', status: 409 };
    if (!doc.recipient) return { error: 'The invoice has no customer email.', status: 400 };
    const body = bounded(text, 4000);
    if (body.length < 10) return { error: 'A reminder message is required.', status: 400 };
    const claimed = await db().execute(sql`UPDATE legacy_invoices SET last_reminded_at=now(),version=version+1 WHERE document=${id}::uuid AND status='open' AND version=${version} RETURNING version`);
    if (!claimed.rows.length) return { error: 'This reminder page is out of date.', status: 409 };
    try { await mail({ to: doc.recipient, subject: `Payment reminder: ${doc.title}`, body }); }
    catch { return { error: 'The email provider failed; the invoice still shows as open.', status: 502 }; }
    await event(id, 'reminder_sent', String(invoice.version + 1));
    return { ok: true, version: invoice.version + 1 };
  }

  return async request => {
    try {
      await ensure();
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const access = readOwnerToken(url.searchParams.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
        if (!access || access.scope !== 'invoice-reminder' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
        const doc = await getDoc(access.id), invoice = await getInvoice(access.id);
        if (!doc || !invoice) return page('<h1>Invoice not found</h1>', 404);
        if (invoice.status === 'paid') return approvedPage(doc, invoice, 'This invoice is paid; no reminder is needed.');
        return reminderPage(doc, invoice, defaultText(doc, invoice), url.searchParams.get('token'));
      }
      if (request.method !== 'POST') return json({ error: 'GET or POST required.' }, 405);
      if (Number(request.headers.get('content-length') || 0) > 16000) return json({ error: 'Too large.' }, 413);
      if (request.headers.get('content-type')?.includes('application/json')) {
        if (!env.INVOICE_SECRET && !env.RECEPTIONIST_WEBHOOK_SECRET) return json({ error: 'Not authorized.' }, 401);
        if (!frontdeskSecret(request).some(value => secretMatches(value, env.INVOICE_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 16000) return json({ error: 'Too large.' }, 413);
        const input = JSON.parse(raw);
        if (input.action === 'chase') return json(await chase());
        const id = bounded(input.document_id, 36);
        if (!/^[a-f0-9-]{36}$/.test(id)) return json({ error: 'A document id is required.' }, 400);
        const doc = await getDoc(id);
        if (!doc || doc.kind !== 'invoice') return json({ error: 'An invoice document is required.' }, 400);
        if (input.action === 'paid') {
          const paid = await db().execute(sql`UPDATE legacy_invoices SET status='paid',paid_at=now() WHERE document=${id}::uuid AND status='open' RETURNING document`);
          if (!paid.rows.length) return json({ error: 'No open invoice for that document.' }, 409);
          await event(id, 'paid');
          return json({ ok: true, status: 'paid' });
        }
        if (input.action && input.action !== 'register') return json({ error: 'Unknown action.' }, 400);
        if (!['sent', 'signed'].includes(doc.status)) return json({ error: 'Deliver the invoice before registering it.' }, 409);
        try {
          const result = await createInvoiceRecord(db(), { document: id, amount_cents: input.amount_cents, due_date: input.due_date, job_id: input.job_id });
          if (!result.registered) return json({ error: 'That invoice is already registered.' }, 409);
          return json({ ok: true, document_id: id, status: 'open', amount_cents: result.amount_cents, due_date: result.due_date, job_id: result.job_id });
        } catch (error) {
          if (error.status) return json({ error: error.message }, error.status);
          throw error;
        }
      }
      const form = await request.formData();
      const access = readOwnerToken(form.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
      if (!access || access.scope !== 'invoice-reminder' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
      if (form.get('action') !== 'send') return page('<h1>Unknown action</h1>', 400);
      const version = Number(form.get('version'));
      if (!Number.isSafeInteger(version)) return page('<h1>This page is out of date</h1>', 409);
      const result = await approveReminder(access.id, form.get('text'), version);
      if (result.error) return page(`<h1>${esc(result.error)}</h1>`, result.status);
      return approvedPage(await getDoc(access.id), await getInvoice(access.id), 'Reminder sent to the customer.');
    } catch { return json({ error: 'The invoice action could not be completed.' }, 500); }
  };
}
