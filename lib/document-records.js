import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { localParts } from './assistant.js';
import { catalog } from './concierge/contracts.js';
import { createInvoiceRecord } from './invoices.js';

// Platform-side deterministic capture for owner-dictated documents: strict item
// validation, string-exact money, sequential reference numbers, and idempotent
// quote->inquiry upserts. Darla never computes any of this; the platform does.

// Quantities and unit prices arrive from the phone as numbers or strings. Both
// are normalized to their plain-decimal String() form and regex-checked, so
// exponent or scientific forms are rejected and no float ambiguity is stored.
const DECIMAL = /^\d{1,6}(\.\d{1,2})?$/;
const decimalField = z.preprocess(value => String(value ?? ''), z.string().regex(DECIMAL, 'Use a plain decimal like 4 or 19.99.'));
export const draftItemsSchema = z.array(z.object({
  description: z.string().trim().min(1).max(200),
  qty: decimalField,
  unit_price: decimalField,
}).strict()).min(1).max(50)
  .refine(items => items.every(item => itemsTotalCents([item]) > 0),
    'Each line item needs a quantity and a unit price above zero.');

const stringToCents = value => {
  const [whole = '', frac = ''] = String(value ?? '').trim().split('.');
  return /^\d+$/.test(whole) && /^\d{0,2}$/.test(frac) ? Number(whole) * 100 + Number(frac.padEnd(2, '0')) : 0;
};

// Per-line Math.round(qty * unit_price_cents), summed. unit_price goes to cents
// by string arithmetic (split on '.', pad the fraction to 2) — never a floating
// multiplication — so totals are exact for every accepted decimal.
export function itemsTotalCents(items) {
  return (Array.isArray(items) ? items : []).reduce((sum, item) => {
    if (!item || typeof item !== 'object') return sum;
    const units = Number(String(item.qty ?? '').trim());
    return sum + (Number.isFinite(units) ? Math.round(units * stringToCents(item.unit_price)) : 0);
  }, 0);
}

// Net 7: the issued local date in the owner's time zone, plus seven calendar
// days (anchored at UTC noon so a DST boundary cannot shift the result).
export function net7Due(date) {
  const { date: issued } = localParts(date);
  return new Date(Date.parse(`${issued}T12:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
}

// The counters table plus guarded copies of the CRM tables from
// migrations/0000_legacy_crm.sql — production has them via the hand migration;
// PGlite test databases need the guard (same pattern as lib/assistant.js).
export async function ensureRecordSchema(db) {
  await db.execute(sql.raw('CREATE TABLE IF NOT EXISTS legacy_document_counters (kind text PRIMARY KEY, seq integer NOT NULL DEFAULT 0)'));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_contacts (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  company text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
)`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_inquiries (
  id uuid PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES legacy_contacts(id),
  message text NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','reviewed','closed')),
  catalog_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)`));
  for (const table of ['legacy_document_counters', 'legacy_contacts', 'legacy_inquiries']) {
    await db.execute(sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
  }
}

// Q-### / INV-### assigned at issuance, never dictated. The counter row
// serializes concurrent approvals; each call advances the sequence exactly once.
export async function nextReference(db, kind) {
  await ensureRecordSchema(db);
  await db.execute(sql`INSERT INTO legacy_document_counters(kind,seq) VALUES (${kind},0) ON CONFLICT (kind) DO NOTHING`);
  const row = (await db.execute(sql`UPDATE legacy_document_counters SET seq=seq+1 WHERE kind=${kind} RETURNING seq`)).rows[0];
  return `${kind === 'invoice' ? 'INV' : 'Q'}-${String(row.seq).padStart(3, '0')}`;
}

// Both uuids derive from the source id (uuidv5-style sha1 over a fixed
// namespace), so replaying the same approval is idempotent with no linkage
// column and no fabricated consent events — provenance stays honest.
const NAMESPACE = 'legacy-ai-document-records-v1';
const deriveUuid = label => {
  const hash = createHash('sha1').update(`${NAMESPACE}:${label}`, 'utf8').digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
};

export async function ensureQuoteInquiryRecord(db, { sourceId, email, name = '', company = '', message }) {
  await ensureRecordSchema(db);
  const contactId = deriveUuid(`contact:${sourceId}`), inquiryId = deriveUuid(`inquiry:${sourceId}`);
  const existing = (await db.execute(sql`SELECT id FROM legacy_contacts WHERE email=${email} LIMIT 1`)).rows[0];
  const contact = existing ? existing.id : contactId;
  if (!existing) await db.execute(sql`INSERT INTO legacy_contacts(id,name,email,company) VALUES (${contactId}::uuid,${name},${email},${company}) ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`INSERT INTO legacy_inquiries(id,contact_id,message,catalog_version) VALUES (${inquiryId}::uuid,${contact}::uuid,${message},${catalog.version}) ON CONFLICT (id) DO NOTHING`);
  return { contactId: contact, inquiryId };
}

// Approval-time invoice registration for dictated drafts. With captured items
// the platform computes the total from those items and issues a Net-7 due date;
// a prose-only invoice never fabricates an amount — the owner's manual register
// path (lib/invoices.js) stays the only way to register one.
export async function registerDraftInvoice(db, { document, items }) {
  const normalized = (Array.isArray(items) ? items : []).filter(item => item && typeof item === 'object');
  if (!normalized.length) return { registered: false, reason: 'no-items' };
  const result = await createInvoiceRecord(db, { document, amount_cents: itemsTotalCents(normalized), due_date: net7Due(new Date()), job_id: null });
  return result.registered ? { ...result, reason: 'items' } : { ...result, reason: 'already-registered' };
}
