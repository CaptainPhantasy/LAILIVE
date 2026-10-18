import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES, frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { signOwnerToken, readOwnerToken } from './owner-documents-core.js';
import { parseCSV, guessMapping } from '../dist/contact-health/core.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const emailOk = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const page = (html, status = 200) => new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legacy AI prospects</title><style>body{font:18px system-ui;max-width:720px;margin:24px auto;padding:16px}h1{font-size:1.4em}ol{padding-left:1.2em}li{margin:12px 0}p{overflow-wrap:anywhere}</style>${html}</html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } });

// The nightly hunt works only from a list the owner supplied. It never crawls the
// web, never guesses contact details, and never contacts a prospect.
export function createProspectHunter({ getDb, mail, env = process.env, now = Date.now, batch = 10 } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_prospects (id uuid PRIMARY KEY, name text NOT NULL, business text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'new', reported_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_prospect_runs (id uuid PRIMARY KEY, count integer NOT NULL, ids jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`));
    for (const table of ['legacy_prospects', 'legacy_prospect_runs']) await db().execute(sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
  })().catch(error => { ready = null; throw error; });
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const link = () => `${origin()}/api/frontdesk/prospects?token=${signOwnerToken({ scope: 'prospects', exp: now() + 14 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET)}`;

  async function hunt() {
    await ensure();
    const rows = (await db().execute(sql`SELECT * FROM legacy_prospects WHERE status='new' ORDER BY created_at ASC LIMIT ${batch}`)).rows;
    if (!rows.length) return { count: 0 };
    const ids = rows.map(row => row.id);
    const list = sql.join(ids.map(id => sql`${id}::uuid`), sql`, `);
    await db().execute(sql`UPDATE legacy_prospects SET status='reported',reported_at=now() WHERE id IN (${list})`);
    const run = randomUUID();
    await db().execute(sql`INSERT INTO legacy_prospect_runs(id,count,ids) VALUES (${run}::uuid,${ids.length},${JSON.stringify(ids)}::jsonb)`);
    const lines = rows.map((row, index) => `${index + 1}. ${row.name}${row.business ? ` — ${row.business}` : ''}${row.phone ? `\n   ${row.phone}` : ''}${row.email ? `\n   ${row.email}` : ''}${row.note ? `\n   ${row.note}` : ''}`).join('\n');
    try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Daily prospect report: ${rows.length}`, body: `Prospects from your supplied list, ready to review:\n\n${lines}\n\nOpen the report:\n${link()}\n\nNo prospect was contacted. Nothing was scraped.` }))); } catch { /* the run stands even when mail fails */ }
    return { count: rows.length, run };
  }

  const view = rows => page(`<h1>Daily prospect report</h1>${rows.length ? `<ol>${rows.map(row => `<li><b>${esc(row.name)}</b>${row.business ? ` — ${esc(row.business)}` : ''}${row.phone ? `<br>${esc(row.phone)}` : ''}${row.email ? `<br>${esc(row.email)}` : ''}${row.note ? `<br><small>${esc(row.note)}</small>` : ''}<br><small>Reported ${esc(String(row.reported_at || ''))}</small></li>`).join('')}</ol>` : '<p>No prospects reported yet.</p>'}<p><small>These came from the list the owner supplied. Nothing was scraped and no prospect was contacted.</small></p>`);

  return async request => {
    try {
      await ensure();
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const access = readOwnerToken(url.searchParams.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
        if (!access || access.scope !== 'prospects') return page('<h1>This link is not valid</h1>', 401);
        const rows = (await db().execute(sql`SELECT * FROM legacy_prospects WHERE status='reported' ORDER BY reported_at DESC LIMIT 50`)).rows;
        return view(rows);
      }
      if (request.method !== 'POST') return json({ error: 'GET or POST required.' }, 405);
      if (Number(request.headers.get('content-length') || 0) > 1100000) return json({ error: 'Too large.' }, 413);
      if (!env.PROSPECT_SECRET && !env.RECEPTIONIST_WEBHOOK_SECRET) return json({ error: 'Not authorized.' }, 401);
      if (!frontdeskSecret(request).some(value => secretMatches(value, env.PROSPECT_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 1100000) return json({ error: 'Too large.' }, 413);
      const input = JSON.parse(raw);
      if (input.action === 'hunt') return json(await hunt());
      if (input.action && input.action !== 'import') return json({ error: 'Unknown action.' }, 400);
      const data = parseCSV(String(input.csv || ''));
      if (!data.rows.length) return json({ error: 'The file needs a header row and at least one record.' }, 400);
      if (data.rows.length > 2000) return json({ error: 'Import at most 2000 prospects at a time.' }, 400);
      const mapping = guessMapping(data.headers);
      const businessIndex = data.headers.findIndex(header => /business|company/i.test(header));
      const noteIndex = data.headers.findIndex(header => /note|service|category|type/i.test(header));
      const value = (row, index) => index >= 0 ? bounded(row.values[index], 254) : '';
      const existing = (await db().execute(sql`SELECT lower(name) AS name, lower(business) AS business, phone FROM legacy_prospects`)).rows;
      const seen = new Set(existing.map(row => `${row.name}|${row.business}|${row.phone}`));
      let created = 0, duplicates = 0, skipped = 0;
      for (const row of data.rows) {
        const name = bounded(row.values[mapping.name] ?? '', 120) || bounded([row.values[mapping.first], row.values[mapping.last]].filter(Boolean).join(' '), 120);
        const business = bounded(businessIndex >= 0 ? row.values[businessIndex] : '', 120);
        const email = value(row, mapping.email).toLowerCase();
        const phone = value(row, mapping.phone);
        const note = bounded(noteIndex >= 0 ? row.values[noteIndex] : '', 300);
        if (!name || (!emailOk(email) && !phone)) { skipped++; continue; }
        const key = `${name.toLowerCase()}|${business.toLowerCase()}|${phone}`;
        if (seen.has(key)) { duplicates++; continue; }
        seen.add(key);
        await db().execute(sql`INSERT INTO legacy_prospects(id,name,business,email,phone,note) VALUES (${randomUUID()}::uuid,${name},${business},${email},${phone},${note})`);
        created++;
      }
      return json({ ok: true, total: data.rows.length, created, duplicates, skipped });
    } catch { return json({ error: 'The prospect action could not be completed.' }, 500); }
  };
}
