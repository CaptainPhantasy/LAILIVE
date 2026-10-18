import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES, frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { signOwnerToken, readOwnerToken } from './owner-documents-core.js';
import { parseCSV } from '../dist/contact-health/core.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, currency = 'USD') => currency === 'USD' ? `$${(Number(cents) / 100).toFixed(2)}` : `${(Number(cents) / 100).toFixed(2)} ${currency}`;
const page = (html, status = 200) => new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legacy AI subscription audit</title><style>body{font:18px system-ui;max-width:760px;margin:24px auto;padding:16px}h1{font-size:1.4em}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd;font-size:16px}td.num,th.num{text-align:right}p{overflow-wrap:anywhere}</style>${html}</html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } });

// Reads a statement the owner exports from their bank or card. It groups repeated
// charges into likely subscriptions and states its inference; it cancels nothing.
export function analyzeCharges(data) {
  const header = name => data.headers.findIndex(value => new RegExp(name, 'i').test(value));
  const dateIndex = header('date'), descIndex = header('desc|merchant|payee|name'), amountIndex = header('amount|debit|charge');
  if (dateIndex < 0 || descIndex < 0 || amountIndex < 0) throw new Error('The file needs date, description, and amount columns.');
  const normalize = value => String(value || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/\b\d{3,}\b/g, ' ').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const groups = new Map();
  let ignored = 0, currencies = new Set();
  for (const row of data.rows) {
    const rawDate = String(row.values[dateIndex] || '').trim();
    const timestamp = Date.parse(rawDate.includes('/') ? rawDate.replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2') : rawDate);
    const amount = Number(String(row.values[amountIndex] || '').replace(/[^0-9.-]/g, ''));
    const merchant = String(row.values[descIndex] || '').trim();
    if (!Number.isFinite(timestamp) || !Number.isFinite(amount) || amount === 0 || !merchant) { ignored++; continue; }
    const currency = (String(row.values[amountIndex]).match(/[A-Z]{3}/) || ['USD'])[0];
    currencies.add(currency);
    // Currency is part of the identity: two charges in different currencies are
    // not the same subscription and must never share a total.
    const key = `${currency}:${normalize(merchant).slice(0, 80) || merchant.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ date: timestamp, amount: Math.abs(amount) * 100, merchant, currency });
  }
  const cadenceFor = days => days >= 6 && days <= 8 ? 'weekly' : days >= 12 && days <= 16 ? 'biweekly' : days >= 26 && days <= 35 ? 'monthly' : days >= 80 && days <= 100 ? 'quarterly' : days >= 350 && days <= 380 ? 'yearly' : 'irregular';
  const perMonth = (average, cadence) => cadence === 'weekly' ? average * 52 / 12 : cadence === 'biweekly' ? average * 26 / 12 : cadence === 'monthly' ? average : cadence === 'quarterly' ? average / 3 : cadence === 'yearly' ? average / 12 : 0;
  const subscriptions = [], irregular = [];
  for (const charges of groups.values()) {
    if (charges.length < 2) continue;
    const sorted = [...charges].sort((a, b) => a.date - b.date);
    const gaps = sorted.slice(1).map((charge, index) => Math.round((charge.date - sorted[index].date) / 86400000)).filter(days => days > 0);
    const median = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
    const cadence = cadenceFor(median);
    const average = Math.round(sorted.reduce((sum, charge) => sum + charge.amount, 0) / sorted.length);
    const entry = { merchant: sorted.at(-1).merchant, currency: sorted.at(-1).currency, charges: sorted.length, cadence, average_cents: average, monthly_cents: Math.round(perMonth(average, cadence)), last_seen: new Date(sorted.at(-1).date).toISOString().slice(0, 10) };
    if (cadence === 'irregular') irregular.push(entry); else subscriptions.push(entry);
  }
  subscriptions.sort((a, b) => b.monthly_cents - a.monthly_cents);
  const monthlyByCurrency = {};
  for (const item of subscriptions) monthlyByCurrency[item.currency] = (monthlyByCurrency[item.currency] || 0) + item.monthly_cents;
  const single = currencies.size <= 1 ? ([...currencies][0] || 'USD') : null;
  return {
    subscriptions, irregular, ignored_rows: ignored, charges: data.rows.length,
    currency: single,
    monthly_by_currency: monthlyByCurrency,
    // A single grand total is only meaningful in one currency; a mixed statement
    // reports one total per currency instead of adding unlike amounts together.
    monthly_cents: single ? (monthlyByCurrency[single] || 0) : null,
    note: 'Cadence is inferred from the gaps between charges. Review each item before changing anything; this audit cancels nothing.',
  };
}

export function createSubscriptionAuditHandler({ getDb, mail, env = process.env, now = Date.now } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_subscription_audits (id uuid PRIMARY KEY, report jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw('ALTER TABLE legacy_subscription_audits ENABLE ROW LEVEL SECURITY'));
  })().catch(error => { ready = null; throw error; });
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const link = id => `${origin()}/api/frontdesk/subscriptions?token=${signOwnerToken({ id, scope: 'subscriptions', exp: now() + 14 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET)}`;
  const table = report => `<table><tr><th>Merchant</th><th>Cadence</th><th class="num">Avg charge</th><th class="num">Monthly</th><th>Last seen</th></tr>
    ${report.subscriptions.map(item => `<tr><td>${esc(item.merchant)}</td><td>${esc(item.cadence)}</td><td class="num">${money(item.average_cents, item.currency)}</td><td class="num">${money(item.monthly_cents, item.currency)}</td><td>${esc(item.last_seen)}</td></tr>`).join('')}
    ${Object.entries(report.monthly_by_currency || {}).map(([currency, cents]) => `<tr><th>Total ${esc(currency)}</th><th></th><th></th><th class="num">${money(cents, currency)}</th><th>${Math.round(cents * 12 / 100)} per year</th></tr>`).join('')}</table>
    ${report.currency ? '' : '<p><small>This statement mixes currencies, so each total is reported separately. They are not added together.</small></p>'}
    ${report.irregular.length ? `<h2>Repeated but irregular</h2><ul>${report.irregular.map(item => `<li>${esc(item.merchant)} · ${item.charges} charges · average ${money(item.average_cents, item.currency)}</li>`).join('')}</ul>` : ''}
    <p><small>${esc(report.note)} Rows ignored: ${report.ignored_rows} of ${report.charges}.</small></p>`;

  return async request => {
    try {
      await ensure();
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const access = readOwnerToken(url.searchParams.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
        if (!access || access.scope !== 'subscriptions' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
        const row = (await db().execute(sql`SELECT report FROM legacy_subscription_audits WHERE id=${access.id}::uuid`)).rows[0];
        if (!row) return page('<h1>Audit not found</h1>', 404);
        const report = typeof row.report === 'string' ? JSON.parse(row.report) : row.report;
        return page(`<h1>Subscription audit</h1>${table(report)}`);
      }
      if (request.method !== 'POST') return json({ error: 'GET or POST required.' }, 405);
      if (Number(request.headers.get('content-length') || 0) > 2100000) return json({ error: 'Too large.' }, 413);
      if (!env.SUBSCRIPTION_SECRET && !env.RECEPTIONIST_WEBHOOK_SECRET) return json({ error: 'Not authorized.' }, 401);
      if (!frontdeskSecret(request).some(value => secretMatches(value, env.SUBSCRIPTION_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 2100000) return json({ error: 'Too large.' }, 413);
      const input = JSON.parse(raw);
      const data = parseCSV(String(input.csv || ''));
      if (!data.rows.length) return json({ error: 'The file needs a header row and at least one charge.' }, 400);
      if (data.rows.length > 5000) return json({ error: 'Use at most 5000 rows at a time.' }, 400);
      const report = analyzeCharges(data);
      const id = randomUUID();
      await db().execute(sql`INSERT INTO legacy_subscription_audits(id,report) VALUES (${id}::uuid,${JSON.stringify(report)}::jsonb)`);
      try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Subscription audit: ${report.currency ? `${money(report.monthly_cents)} per month` : 'mixed currencies'}`, body: `${report.subscriptions.length} likely recurring charges found.\n\n${Object.entries(report.monthly_by_currency || {}).map(([currency, cents]) => `Monthly total (${currency}): ${money(cents, currency)}`).join('\n')}\n\nOpen the audit:\n${link(id)}\n\nCadence is inferred from charge spacing. Nothing was cancelled.` }))); } catch { /* the audit stands even when mail fails */ }
      return json({ ok: true, id, ...report });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const safe = /columns|header|record|5000/i.test(message) ? message : 'The subscription audit could not be completed.';
      return json({ error: safe }, 400);
    }
  };
}
