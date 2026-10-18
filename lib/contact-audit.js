import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { parseCSV, guessMapping, analyze, draftRows, encodeCSV } from '../dist/contact-health/core.js';
import { OWNER_ADDRESSES } from './frontdesk.js';
import { signOwnerToken, readOwnerToken } from './owner-documents-core.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function createContactAuditHandler({ getDb, mail, env = process.env, now = Date.now } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_contact_audits (id uuid PRIMARY KEY, filename text NOT NULL, summary jsonb NOT NULL, csv text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw('ALTER TABLE legacy_contact_audits ENABLE ROW LEVEL SECURITY'));
  })().catch(error => { ready = null; throw error; });
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;

  return async request => {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const access = readOwnerToken(url.searchParams.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
        if (!access || access.scope !== 'contact-audit' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return json({ error: 'Download link is invalid or expired.' }, 401);
        await ensure();
        const row = (await db().execute(sql`SELECT filename,csv FROM legacy_contact_audits WHERE id=${access.id}::uuid`)).rows[0];
        if (!row) return json({ error: 'Audit not found.' }, 404);
        const filename = String(row.filename).replace(/[^A-Za-z0-9._-]/g, '_');
        return new Response(row.csv, { headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="cleaned-${filename}"`,
          'Cache-Control': 'no-store',
        } });
      }
      if (request.method !== 'POST') return json({ error: 'POST or GET required.' }, 405);
      const secret = env.OWNER_AUDIT_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET;
      if (!secret || request.headers.get('x-owner-audit-secret') !== secret) return json({ error: 'Not authorized.' }, 401);
      if (Number(request.headers.get('content-length') || 0) > 2_100_000) return json({ error: 'Too large.' }, 413);
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 2_100_000) return json({ error: 'Too large.' }, 413);
      const payload = JSON.parse(raw);
      const filename = bounded(payload.filename, 120) || 'contacts.csv';
      const data = parseCSV(String(payload.csv || ''));
      const mapping = guessMapping(data.headers);
      const report = analyze(data, mapping);
      const cleanedRows = draftRows(data, report, { removeDuplicates: true, trim: true });
      const cleaned = encodeCSV(cleanedRows);
      const summary = { ...report.summary, issues: report.issues.length, rowsKept: cleanedRows.length };
      const id = randomUUID();
      await ensure();
      await db().execute(sql`INSERT INTO legacy_contact_audits(id,filename,summary,csv) VALUES (${id}::uuid,${filename},${JSON.stringify(summary)}::jsonb,${cleaned})`);
      const token = signOwnerToken({ id, scope: 'contact-audit', exp: now() + 7 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET);
      const download = `${origin()}/api/frontdesk/contact-audit?id=${id}&token=${token}`;
      const message = `Contact-list audit for ${filename}\n\nRecords: ${summary.records}\nWith issues: ${summary.withIssues}\nExact duplicates: ${summary.exactDuplicates}\nPossible conflicts: ${summary.possibleConflicts}\nRows kept in the cleaned file: ${summary.rowsKept}\n\nDownload the cleaned CSV:\n${download}\n\nNo contact was emailed and no record was merged.`;
      await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Contact-list audit: ${filename}`, body: message })));
      return json({ ok: true, id, summary, download });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const safe = /2 MB|header row|fields|columns|separator|quote|record/i.test(message) ? message : 'The contact audit could not be completed.';
      return json({ error: safe }, 400);
    }
  };
}
