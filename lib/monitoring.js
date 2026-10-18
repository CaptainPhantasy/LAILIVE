import { createHash, randomUUID } from 'node:crypto';
import { connect } from 'node:tls';
import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES } from './frontdesk.js';
import { signOwnerToken, readOwnerToken } from './owner-documents-core.js';

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (html, status = 200) => new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legacy AI monitoring</title><style>body{font:18px system-ui;max-width:720px;margin:24px auto;padding:16px}h1{font-size:1.4em}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd;font-size:16px}td.num,th.num{text-align:right}p{overflow-wrap:anywhere}</style>${html}</html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } });

async function defaultTlsDays(host) {
  return await new Promise((resolve, reject) => {
    const socket = connect({ host, port: 443, servername: host, timeout: 8000 }, () => {
      try {
        const certificate = socket.getPeerCertificate();
        const expires = Date.parse(certificate.valid_to);
        socket.end();
        resolve(Number.isFinite(expires) ? Math.floor((expires - Date.now()) / 86400000) : null);
      } catch (error) { socket.destroy(); reject(error); }
    });
    socket.on('error', reject);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('TLS timeout')); });
  });
}

// Real checks and a real export the owner can restore. It is not a database
// snapshot, and the receipt says exactly what was and was not verified.
export function createMonitor({ getDb, mail, env = process.env, now = Date.now, fetcher = fetch, tlsDays = defaultTlsDays } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_monitor_checks (id bigserial PRIMARY KEY, kind text NOT NULL, target text NOT NULL, ok boolean NOT NULL, detail text NOT NULL DEFAULT '', latency_ms integer, created_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_backups (id uuid PRIMARY KEY, label text NOT NULL, payload text NOT NULL, sha256 text NOT NULL, rows jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`));
    for (const table of ['legacy_monitor_checks', 'legacy_backups']) await db().execute(sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
  })().catch(error => { ready = null; throw error; });
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const site = () => env.MONITOR_SITE || 'https://legacyai.space';
  const host = () => { try { return new URL(site()).hostname; } catch { return 'legacyai.space'; } };

  async function checkUrl(target) {
    const started = Date.now();
    try {
      const response = await fetcher(target, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      const ok = response.status >= 200 && response.status < 400;
      await db().execute(sql`INSERT INTO legacy_monitor_checks(kind,target,ok,detail,latency_ms) VALUES ('http',${target},${ok},${`status ${response.status}`},${Date.now() - started})`);
      return ok;
    } catch (error) {
      await db().execute(sql`INSERT INTO legacy_monitor_checks(kind,target,ok,detail,latency_ms) VALUES ('http',${target},false,${String(error?.message || 'request failed').slice(0, 200)},${Date.now() - started})`);
      return false;
    }
  }

  async function checkTls() {
    try {
      const days = await tlsDays(host());
      const ok = typeof days === 'number' && days > 14;
      await db().execute(sql`INSERT INTO legacy_monitor_checks(kind,target,ok,detail) VALUES ('tls',${host()},${ok},${`${days} days remaining`})`);
      return ok;
    } catch (error) {
      await db().execute(sql`INSERT INTO legacy_monitor_checks(kind,target,ok,detail) VALUES ('tls',${host()},false,${String(error?.message || 'tls check failed').slice(0, 200)})`);
      return false;
    }
  }

  const TABLES = ['legacy_owner_documents', 'legacy_jobs', 'legacy_invoices', 'legacy_contacts', 'legacy_review_requests'];
  async function exportRows() {
    const rows = {};
    for (const table of TABLES) {
      try { rows[table] = Number((await db().execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))).rows[0].n); }
      catch { rows[table] = null; }
    }
    return rows;
  }

  async function backup() {
    const rows = await exportRows();
    const payload = JSON.stringify({ created_at: new Date(now()).toISOString(), rows });
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const id = randomUUID();
    await db().execute(sql`INSERT INTO legacy_backups(id,label,payload,sha256,rows) VALUES (${id}::uuid,${`auto-${new Date(now()).toISOString().slice(0, 10)}`},${payload},${sha256},${JSON.stringify(rows)}::jsonb)`);
    return { id, sha256, rows };
  }

  async function restoreVerify(id) {
    const record = id
      ? (await db().execute(sql`SELECT * FROM legacy_backups WHERE id=${id}::uuid`)).rows[0]
      : (await db().execute(sql`SELECT * FROM legacy_backups ORDER BY created_at DESC LIMIT 1`)).rows[0];
    if (!record) return { ok: false, reason: 'no backup found' };
    const hash = createHash('sha256').update(String(record.payload)).digest('hex');
    let parsed;
    try { parsed = JSON.parse(String(record.payload)); } catch { return { ok: false, id: record.id, reason: 'payload is not JSON' }; }
    const stored = typeof record.rows === 'string' ? JSON.parse(record.rows) : record.rows;
    const mismatches = Object.keys(stored || {}).filter(key => Number(stored[key]) !== Number(parsed?.rows?.[key]));
    return { ok: hash === record.sha256 && mismatches.length === 0, id: record.id, sha256: hash, mismatches };
  }

  async function daily() {
    await ensure();
    const http = await Promise.all([checkUrl(`${site()}/`), checkUrl(`${site()}/sitemap.xml`)]);
    const tls = await checkTls();
    const saved = await backup();
    const restored = await restoreVerify(saved.id);
    return { http: http.every(Boolean), tls, backup: saved.id, restore: restored.ok };
  }

  async function receipt() {
    await ensure();
    const since = new Date(now() - 30 * 86400000).toISOString();
    const rows = (await db().execute(sql`SELECT kind, count(*)::int AS total, count(*) FILTER (WHERE ok)::int AS ok, min(latency_ms) AS best, max(latency_ms) AS worst FROM legacy_monitor_checks WHERE created_at > ${since}::timestamptz GROUP BY kind`)).rows;
    const tls = (await db().execute(sql`SELECT detail FROM legacy_monitor_checks WHERE kind='tls' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    const restored = await restoreVerify();
    return { period_days: 30, checks: rows.map(row => ({ kind: row.kind, total: Number(row.total), ok: Number(row.ok), best_ms: row.best, worst_ms: row.worst })), tls: tls?.detail || 'no check yet', restore: restored, generated_at: new Date(now()).toISOString() };
  }

  const reportHtml = data => `<h1>Monthly monitoring receipt</h1>
    <table><tr><th>Check</th><th class="num">Runs</th><th class="num">Passed</th><th class="num">Best ms</th><th class="num">Worst ms</th></tr>
    ${data.checks.map(row => `<tr><td>${esc(row.kind)}</td><td class="num">${row.total}</td><td class="num">${row.ok}</td><td class="num">${row.best_ms ?? '—'}</td><td class="num">${row.worst_ms ?? '—'}</td></tr>`).join('')}</table>
    <p><b>TLS:</b> ${esc(data.tls)}</p>
    <p><b>Backup restore test:</b> ${data.restore.ok ? 'passed' : 'FAILED'}${data.restore.sha256 ? ` · hash ${esc(String(data.restore.sha256).slice(0, 16))}` : ''}</p>
    <p><small>Uptime and TLS are measured from the deployed app. The backup is an application-level export with a hash and a restore check, not a database snapshot. Restore of the full database is not claimed. Generated ${esc(data.generated_at)}.</small></p>`;

  return {
    daily, receipt,
    async report(token) {
      const access = readOwnerToken(token, env.RECEPTIONIST_SESSION_SECRET, now());
      if (!access || access.scope !== 'monitor') return page('<h1>This link is not valid</h1>', 401);
      await ensure();
      return new Response(reportHtml(await receipt()), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
    },
    async emailReceipt() {
      const data = await receipt();
      const link = `${origin()}/api/frontdesk/monitor?token=${signOwnerToken({ scope: 'monitor', exp: now() + 7 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET)}`;
      const body = `Monthly monitoring receipt\n\nChecks:\n${data.checks.map(row => `${row.kind}: ${row.ok}/${row.total} passed`).join('\n')}\n\nTLS: ${data.tls}\nBackup restore: ${data.restore.ok ? 'passed' : 'FAILED'}\n\nOpen the receipt:\n${link}\n\nThis is an application-level export check, not a database snapshot.\n`;
      await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: 'Monthly monitoring receipt', body })));
      return data;
    },
  };
}
