import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES, frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { signOwnerToken, readOwnerToken } from './owner-documents-core.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = cents => `$${(Number(cents) / 100).toFixed(2)}`;
const page = (html, status = 200) => new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legacy AI revenue by source</title><style>body{font:18px system-ui;max-width:760px;margin:24px auto;padding:16px}h1{font-size:1.4em}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd;font-size:16px}td.num,th.num{text-align:right}p{overflow-wrap:anywhere}</style>${html}</html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } });

// Revenue is attributed through the job's recorded source and the invoice linked
// to that job. Invoices with no job are shown separately, never guessed.
export function createRevenueHandler({ getDb, mail, env = process.env, now = Date.now } = {}) {
  const db = () => getDb();
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const link = () => `${origin()}/api/frontdesk/revenue?token=${signOwnerToken({ scope: 'revenue', exp: now() + 7 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET)}`;

  async function report() {
    const rows = (await db().execute(sql`SELECT COALESCE(NULLIF(j.source,''),'(no source)') AS source,
        count(DISTINCT j.id)::int AS jobs,
        COALESCE(sum(i.amount_cents),0)::bigint AS invoiced_cents,
        COALESCE(sum(CASE WHEN i.status='paid' THEN i.amount_cents ELSE 0 END),0)::bigint AS paid_cents
      FROM legacy_jobs j LEFT JOIN legacy_invoices i ON i.job=j.id
      GROUP BY 1 ORDER BY invoiced_cents DESC`)).rows;
    const unlinked = (await db().execute(sql`SELECT COALESCE(sum(amount_cents),0)::bigint AS invoiced_cents,
        COALESCE(sum(CASE WHEN status='paid' THEN amount_cents ELSE 0 END),0)::bigint AS paid_cents
      FROM legacy_invoices WHERE job IS NULL`)).rows[0];
    const sources = rows.map(row => ({ source: row.source, jobs: Number(row.jobs), invoiced_cents: Number(row.invoiced_cents), paid_cents: Number(row.paid_cents) }));
    const totals = {
      jobs: sources.reduce((sum, row) => sum + row.jobs, 0),
      invoiced_cents: sources.reduce((sum, row) => sum + row.invoiced_cents, 0) + Number(unlinked?.invoiced_cents || 0),
      paid_cents: sources.reduce((sum, row) => sum + row.paid_cents, 0) + Number(unlinked?.paid_cents || 0),
    };
    return { sources, unlinked: { invoiced_cents: Number(unlinked?.invoiced_cents || 0), paid_cents: Number(unlinked?.paid_cents || 0) }, totals, generated_at: new Date(now()).toISOString() };
  }

  const table = data => `<table><tr><th>Source</th><th class="num">Jobs</th><th class="num">Invoiced</th><th class="num">Paid</th></tr>
    ${data.sources.map(row => `<tr><td>${esc(row.source)}</td><td class="num">${row.jobs}</td><td class="num">${money(row.invoiced_cents)}</td><td class="num">${money(row.paid_cents)}</td></tr>`).join('')}
    ${data.unlinked.invoiced_cents || data.unlinked.paid_cents ? `<tr><td>(no job linked)</td><td class="num">—</td><td class="num">${money(data.unlinked.invoiced_cents)}</td><td class="num">${money(data.unlinked.paid_cents)}</td></tr>` : ''}
    <tr><th>Total</th><th class="num">${data.totals.jobs}</th><th class="num">${money(data.totals.invoiced_cents)}</th><th class="num">${money(data.totals.paid_cents)}</th></tr></table>
    <p><small>Revenue is grouped by the source recorded on the job and the invoice linked to that job. Ad spend is not included. Generated ${esc(data.generated_at)}.</small></p>`;

  return async request => {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const access = readOwnerToken(url.searchParams.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
        if (!access || access.scope !== 'revenue') return page('<h1>This link is not valid</h1>', 401);
        return page(`<h1>Where the money came from</h1>${table(await report())}`);
      }
      if (request.method !== 'POST') return json({ error: 'GET or POST required.' }, 405);
      if (Number(request.headers.get('content-length') || 0) > 4000) return json({ error: 'Too large.' }, 413);
      if (!env.REVENUE_SECRET && !env.RECEPTIONIST_WEBHOOK_SECRET) return json({ error: 'Not authorized.' }, 401);
      if (!frontdeskSecret(request).some(value => secretMatches(value, env.REVENUE_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
      const raw = await request.text();
      const input = raw ? JSON.parse(raw) : {};
      if (input.action && input.action !== 'report') return json({ error: 'Unknown action.' }, 400);
      const data = await report(), reportLink = link();
      try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: 'Revenue by source', body: `Invoiced ${money(data.totals.invoiced_cents)} · paid ${money(data.totals.paid_cents)} across ${data.totals.jobs} jobs.\n\n${data.sources.map(row => `${row.source}: ${money(row.invoiced_cents)} invoiced, ${money(row.paid_cents)} paid`).join('\n')}\n\nOpen the report:\n${reportLink}\n\nAd spend is not included.` }))); } catch { /* the report is still returned */ }
      return json({ ...data, url: reportLink });
    } catch { return json({ error: 'The revenue report could not be completed.' }, 500); }
  };
}
