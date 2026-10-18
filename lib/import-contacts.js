import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES, frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { parseCSV, guessMapping } from '../dist/contact-health/core.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const emailOk = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// Moves a customer list from another system into the Legacy AI contact store.
// Preview never writes; commit inserts only rows that pass validation and do not
// already exist. Nothing is emailed to a customer and no record is merged.
export function createContactImportHandler({ getDb, mail, env = process.env, now = Date.now } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_import_runs (id uuid PRIMARY KEY, filename text NOT NULL, mapping jsonb NOT NULL, total integer NOT NULL, created integer NOT NULL, duplicates integer NOT NULL, skipped integer NOT NULL, reasons jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_contact_phones (contact_id uuid NOT NULL, phone text NOT NULL, PRIMARY KEY (contact_id, phone))`));
    for (const table of ['legacy_import_runs', 'legacy_contact_phones']) await db().execute(sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
  })().catch(error => { ready = null; throw error; });

  async function analyze(input) {
    const filename = bounded(input.filename, 120) || 'contacts.csv';
    const raw = String(input.csv || '');
    if (Buffer.byteLength(raw) > 2000000) throw new Error('The file must be 2 MB or smaller.');
    const data = parseCSV(raw);
    if (!data.headers.length || !data.rows.length) throw new Error('The file needs a header row and at least one record.');
    if (data.rows.length > 5000) throw new Error('Import at most 5000 rows at a time.');
    const mapping = guessMapping(data.headers);
    if (mapping.email < 0) throw new Error('The file needs an email column.');
    const companyIndex = data.headers.findIndex(header => /company|business/i.test(header));
    const value = (row, index) => index >= 0 ? bounded(row.values[index], 254) : '';
    const existing = new Set((await db().execute(sql`SELECT lower(email) AS email FROM legacy_contacts`)).rows.map(row => row.email));
    const seen = new Set();
    const rows = [], reasons = {};
    let duplicates = 0, skipped = 0;
    const bump = reason => { reasons[reason] = (reasons[reason] || 0) + 1; };
    for (const row of data.rows) {
      const email = value(row, mapping.email).toLowerCase();
      const fullName = bounded(row.values[mapping.name] ?? '', 120) || bounded([row.values[mapping.first], row.values[mapping.last]].filter(Boolean).join(' '), 120);
      const company = bounded(companyIndex >= 0 ? row.values[companyIndex] : '', 120);
      const phone = value(row, mapping.phone);
      if (!emailOk(email)) { skipped++; bump('missing or invalid email'); continue; }
      if (!fullName) { skipped++; bump('missing name'); continue; }
      if (seen.has(email)) { duplicates++; bump('repeated in this file'); continue; }
      seen.add(email);
      if (existing.has(email)) { duplicates++; bump('already in the contact store'); continue; }
      rows.push({ name: fullName, email, company, phone });
    }
    return { filename, mapping, total: data.rows.length, rows, duplicates, skipped, reasons };
  }

  return async request => {
    try {
      await ensure();
      if (request.method !== 'POST') return json({ error: 'POST required.' }, 405);
      if (Number(request.headers.get('content-length') || 0) > 2100000) return json({ error: 'Too large.' }, 413);
      if (!env.IMPORT_SECRET && !env.RECEPTIONIST_WEBHOOK_SECRET) return json({ error: 'Not authorized.' }, 401);
      if (!frontdeskSecret(request).some(value => secretMatches(value, env.IMPORT_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 2100000) return json({ error: 'Too large.' }, 413);
      const input = JSON.parse(raw);
      const action = input.action || 'preview';
      if (!['preview', 'commit'].includes(action)) return json({ error: 'Unknown action.' }, 400);
      const result = await analyze(input);
      const summary = { total: result.total, create: result.rows.length, duplicates: result.duplicates, skipped: result.skipped, reasons: result.reasons, mapping: result.mapping };
      if (action === 'preview') return json({ ok: true, preview: true, ...summary, sample: result.rows.slice(0, 5).map(row => ({ name: row.name, email: row.email, company: row.company })) });

      const id = randomUUID();
      const created = await db().transaction(async tx => {
        let count = 0;
        for (const row of result.rows) {
          const contactId = randomUUID();
          const inserted = await tx.execute(sql`INSERT INTO legacy_contacts(id,name,email,company)
            SELECT ${contactId}::uuid,${row.name},${row.email},${row.company}
            WHERE NOT EXISTS (SELECT 1 FROM legacy_contacts WHERE lower(email)=${row.email})
            RETURNING id`);
          if (!inserted.rows.length) continue;
          count++;
          if (row.phone) { try { await tx.execute(sql`INSERT INTO legacy_contact_phones(contact_id,phone) VALUES (${contactId}::uuid,${row.phone}) ON CONFLICT DO NOTHING`); } catch { /* the contact still lands without the phone */ } }
        }
        await tx.execute(sql`INSERT INTO legacy_import_runs(id,filename,mapping,total,created,duplicates,skipped,reasons) VALUES (${id}::uuid,${result.filename},${JSON.stringify(result.mapping)}::jsonb,${result.total},${count},${result.duplicates},${result.skipped},${JSON.stringify(result.reasons)}::jsonb)`);
        return count;
      });
      try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Contact import: ${result.filename}`, body: `Import finished.\n\nRows read: ${result.total}\nCreated: ${created}\nDuplicates skipped: ${result.duplicates}\nRows skipped: ${result.skipped}\n${Object.entries(result.reasons).map(([reason, count]) => `- ${reason}: ${count}`).join('\n')}\n\nNo customer was emailed and no existing record was merged.` }))); } catch { /* the import stands even when mail fails */ }
      return json({ ok: true, preview: false, id, ...summary, created });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const safe = /2 MB|header|email column|5000|record/i.test(message) ? message : 'The contact import could not be completed.';
      return json({ error: safe }, 400);
    }
  };
}
