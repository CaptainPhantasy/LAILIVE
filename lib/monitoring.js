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

// Real checks and a bounded application export. Its integrity check does not
// restore a database. Owner alerts are durable and tracked for each recipient.
export function createMonitor({ getDb, mail, env = process.env, now = Date.now, fetcher = fetch, tlsDays = defaultTlsDays } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_monitor_checks (id bigserial PRIMARY KEY, kind text NOT NULL, target text NOT NULL, ok boolean NOT NULL, detail text NOT NULL DEFAULT '', latency_ms integer, created_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_backups (id uuid PRIMARY KEY, label text NOT NULL, payload text NOT NULL, sha256 text NOT NULL, rows jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_monitor_incidents (id uuid PRIMARY KEY, kind text NOT NULL, target text NOT NULL, detail text NOT NULL, opened_at timestamptz NOT NULL, recovered_at timestamptz)`));
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_monitor_observations (kind text NOT NULL, target text NOT NULL, observed_at timestamptz NOT NULL, PRIMARY KEY(kind,target))`));
    await db().execute(sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS legacy_monitor_incidents_active ON legacy_monitor_incidents(kind,target) WHERE recovered_at IS NULL`));
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_monitor_alerts (incident uuid NOT NULL REFERENCES legacy_monitor_incidents(id), recipient text NOT NULL, accepted_at timestamptz, attempts integer NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz, last_error text, PRIMARY KEY(incident,recipient))`));
    for (const table of ['legacy_monitor_checks', 'legacy_backups', 'legacy_monitor_incidents', 'legacy_monitor_alerts', 'legacy_monitor_observations']) await db().execute(sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
  })().catch(error => { ready = null; throw error; });
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const site = () => env.MONITOR_SITE || 'https://legacyai.space';
  const host = () => { try { return new URL(site()).hostname; } catch { return 'legacyai.space'; } };

  async function checkUrl(target) {
    const started = Date.now();
    try {
      const response = await fetcher(target, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      const ok = response.status >= 200 && response.status < 400;
      const detail = `status ${response.status}`;
      await db().execute(sql`INSERT INTO legacy_monitor_checks(kind,target,ok,detail,latency_ms) VALUES ('http',${target},${ok},${detail},${Date.now() - started})`);
      return { kind: 'http', target, ok, detail };
    } catch (error) {
      const detail = String(error?.message || 'request failed').slice(0, 200);
      await db().execute(sql`INSERT INTO legacy_monitor_checks(kind,target,ok,detail,latency_ms) VALUES ('http',${target},false,${detail},${Date.now() - started})`);
      return { kind: 'http', target, ok: false, detail };
    }
  }

  async function checkTls() {
    try {
      const days = await tlsDays(host());
      const ok = typeof days === 'number' && days > 14;
      const detail = typeof days === 'number' ? `${days} days remaining` : 'Certificate expiry could not be determined';
      await db().execute(sql`INSERT INTO legacy_monitor_checks(kind,target,ok,detail) VALUES ('tls',${host()},${ok},${detail})`);
      return { kind: 'tls', target: host(), ok, detail };
    } catch (error) {
      const detail = String(error?.message || 'tls check failed').slice(0, 200);
      await db().execute(sql`INSERT INTO legacy_monitor_checks(kind,target,ok,detail) VALUES ('tls',${host()},false,${detail})`);
      return { kind: 'tls', target: host(), ok: false, detail };
    }
  }

  async function recordIncidents(checks, observed) {
    // Recording the incident and its recipient queue in one transaction avoids
    // losing an alert when a run stops between those writes.
    await db().transaction(async tx => {
      for (const check of checks) {
        // An older slow run must not reopen an incident after a newer run has
        // already observed recovery (or clear a newer failure).
        const current = await tx.execute(sql`INSERT INTO legacy_monitor_observations(kind,target,observed_at)
          VALUES (${check.kind},${check.target},${observed}::timestamptz)
          ON CONFLICT (kind,target) DO UPDATE SET observed_at=EXCLUDED.observed_at
          WHERE legacy_monitor_observations.observed_at <= EXCLUDED.observed_at RETURNING kind`);
        if (!current.rows.length) continue;
        if (check.ok) {
          await tx.execute(sql`UPDATE legacy_monitor_incidents SET recovered_at=${observed}::timestamptz WHERE kind=${check.kind} AND target=${check.target} AND recovered_at IS NULL`);
          continue;
        }
        const incident = (await tx.execute(sql`INSERT INTO legacy_monitor_incidents(id,kind,target,detail,opened_at)
          VALUES (${randomUUID()}::uuid,${check.kind},${check.target},${check.detail},${observed}::timestamptz)
          ON CONFLICT (kind,target) WHERE recovered_at IS NULL DO UPDATE SET detail=EXCLUDED.detail RETURNING id`)).rows[0].id;
        for (const recipient of OWNER_ADDRESSES) {
          await tx.execute(sql`INSERT INTO legacy_monitor_alerts(incident,recipient) VALUES (${incident}::uuid,${recipient}) ON CONFLICT DO NOTHING`);
        }
      }
    });
  }

  async function notifyIncidents() {
    let accepted = 0, failed = 0;
    for (const recipient of OWNER_ADDRESSES) {
      const token = randomUUID(), at = new Date(now()).toISOString();
      const leaseUntil = new Date(now() + 10 * 60000).toISOString();
      const incidents = await db().transaction(async tx => {
        const rows = (await tx.execute(sql`SELECT i.* FROM legacy_monitor_incidents i JOIN legacy_monitor_alerts a ON a.incident=i.id
          WHERE a.recipient=${recipient} AND a.accepted_at IS NULL AND (a.lease_until IS NULL OR a.lease_until <= ${at}::timestamptz)
          ORDER BY i.opened_at LIMIT 25 FOR UPDATE OF a SKIP LOCKED`)).rows;
        if (!rows.length) return rows;
        const ids = sql.join(rows.map(row => sql`${row.id}::uuid`), sql`, `);
        await tx.execute(sql`UPDATE legacy_monitor_alerts SET lease_token=${token}::uuid,lease_until=${leaseUntil}::timestamptz,attempts=attempts+1
          WHERE recipient=${recipient} AND incident IN (${ids})`);
        return rows;
      });
      if (!incidents.length) continue;
      const details = incidents.map(row => `${row.kind === 'tls' ? 'Certificate' : 'Page'}: ${row.target}\nResult: ${row.detail}\nFirst detected: ${new Date(row.opened_at).toISOString()}\n${row.recovered_at ? `Recovered: ${new Date(row.recovered_at).toISOString()}` : 'Still failing at the latest scheduled check.'}\nIncident: ${row.id}`).join('\n\n');
      const body = `Monitoring alert for ${site()}\n\n${details}\n\nCheck the affected page and the latest hosting deployment or runtime errors. For a certificate issue, check the domain certificate and its renewal before it expires.\n\nThese are scheduled checks, not continuous monitoring. Accepted alerts are normally suppressed for the same incident. Failed or interrupted sends are retried on a later scheduled run; an interrupted send can result in a repeated email. No customer was contacted.`;
      let sent = false;
      try { sent = await mail({ to: recipient, subject: `Monitoring alert: ${host()}`, body }) === true; } catch { /* retain the pending alert without storing provider error details */ }
      if (sent) {
        await db().execute(sql`UPDATE legacy_monitor_alerts SET accepted_at=${new Date(now()).toISOString()}::timestamptz,lease_token=NULL,lease_until=NULL,last_error=NULL WHERE recipient=${recipient} AND lease_token=${token}::uuid`);
        accepted++;
      } else {
        await db().execute(sql`UPDATE legacy_monitor_alerts SET lease_token=NULL,lease_until=NULL,last_error='Owner email was not accepted.' WHERE recipient=${recipient} AND lease_token=${token}::uuid`);
        failed++;
      }
    }
    const pending = Number((await db().execute(sql`SELECT count(*)::int AS n FROM legacy_monitor_alerts WHERE accepted_at IS NULL`)).rows[0].n);
    return { accepted, failed, pending };
  }

  const TABLES = ['legacy_owner_documents', 'legacy_jobs', 'legacy_invoices', 'legacy_contacts', 'legacy_review_requests'];
  const ROW_CAP = 500, BYTE_BUDGET = 1200000;
  async function exportRows() {
    const counts = {}, tables = {};
    let budget = BYTE_BUDGET;
    for (const table of TABLES) {
      try {
        const total = Number((await db().execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))).rows[0].n);
        counts[table] = total;
        const all = (await db().execute(sql.raw(`SELECT * FROM ${table} LIMIT ${ROW_CAP}`))).rows;
        const kept = [];
        let truncated = all.length < total;
        for (const row of all) {
          const size = JSON.stringify(row).length;
          if (size > budget) { truncated = true; break; }
          kept.push(row);
          budget -= size;
        }
        tables[table] = { rows: kept, truncated };
      } catch {
        counts[table] = null;
        tables[table] = { rows: [], truncated: true };
      }
    }
    return { counts, tables };
  }

  async function backup() {
    const { counts, tables } = await exportRows();
    const payload = JSON.stringify({ created_at: new Date(now()).toISOString(), rows: counts, tables });
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const id = randomUUID();
    await db().execute(sql`INSERT INTO legacy_backups(id,label,payload,sha256,rows) VALUES (${id}::uuid,${`auto-${new Date(now()).toISOString().slice(0, 10)}`},${payload},${sha256},${JSON.stringify(counts)}::jsonb)`);
    return { id, sha256, rows: counts, exported: Object.fromEntries(Object.entries(tables).map(([name, data]) => [name, data.rows.length])) };
  }

  async function verifyExport(id) {
    const record = id
      ? (await db().execute(sql`SELECT * FROM legacy_backups WHERE id=${id}::uuid`)).rows[0]
      : (await db().execute(sql`SELECT * FROM legacy_backups ORDER BY created_at DESC LIMIT 1`)).rows[0];
    if (!record) return { ok: false, reason: 'no backup found' };
    const hash = createHash('sha256').update(String(record.payload)).digest('hex');
    let parsed;
    try { parsed = JSON.parse(String(record.payload)); } catch { return { ok: false, id: record.id, reason: 'payload is not JSON' }; }
    const stored = typeof record.rows === 'string' ? JSON.parse(record.rows) : record.rows;
    const mismatches = Object.keys(stored || {}).filter(key => Number(stored[key]) !== Number(parsed?.rows?.[key]));
    const exported = {};
    for (const [name, data] of Object.entries(parsed?.tables || {})) {
      if (!Array.isArray(data?.rows)) { mismatches.push(`${name}: rows missing`); continue; }
      exported[name] = data.rows.length;
      if (!data.truncated && Number(stored?.[name]) !== data.rows.length) mismatches.push(`${name}: ${data.rows.length} rows stored of ${stored?.[name]}`);
      if (data.rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) mismatches.push(`${name}: an exported row is not an object`);
    }
    const complete = TABLES.every(name => parsed?.tables?.[name]?.truncated === false && Number.isInteger(stored?.[name]));
    return { ok: hash === record.sha256 && mismatches.length === 0, complete, scope: 'application-export-integrity', id: record.id, sha256: hash, mismatches, exported };
  }

  async function daily() {
    const observed = new Date(now()).toISOString();
    await ensure();
    const http = await Promise.all([checkUrl(`${site()}/`), checkUrl(`${site()}/sitemap.xml`)]);
    const tls = await checkTls();
    await recordIncidents([...http, tls], observed);
    // Alert before the export so an unrelated export failure cannot hide a
    // recorded page or certificate failure. Pending mail retries after recovery.
    const alerts = await notifyIncidents();
    const saved = await backup();
    const exported = await verifyExport(saved.id);
    // Existing field names remain aliases for callers of the original route.
    return { http: http.every(check => check.ok), tls: tls.ok, backup: saved.id, restore: exported.ok, export_validation: exported, alerts };
  }

  async function receipt() {
    await ensure();
    const since = new Date(now() - 30 * 86400000).toISOString();
    const rows = (await db().execute(sql`SELECT kind, count(*)::int AS total, count(*) FILTER (WHERE ok)::int AS ok, min(latency_ms) AS best, max(latency_ms) AS worst FROM legacy_monitor_checks WHERE created_at > ${since}::timestamptz GROUP BY kind`)).rows;
    const tls = (await db().execute(sql`SELECT detail FROM legacy_monitor_checks WHERE kind='tls' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    const exported = await verifyExport();
    return { period_days: 30, checks: rows.map(row => ({ kind: row.kind, total: Number(row.total), ok: Number(row.ok), best_ms: row.best, worst_ms: row.worst })), tls: tls?.detail || 'no check yet', export_validation: exported, restore: exported, generated_at: new Date(now()).toISOString() };
  }

  const reportHtml = data => `<h1>Monthly monitoring receipt</h1>
    <table><tr><th>Check</th><th class="num">Runs</th><th class="num">Passed</th><th class="num">Best ms</th><th class="num">Worst ms</th></tr>
    ${data.checks.map(row => `<tr><td>${esc(row.kind)}</td><td class="num">${row.total}</td><td class="num">${row.ok}</td><td class="num">${row.best_ms ?? '—'}</td><td class="num">${row.worst_ms ?? '—'}</td></tr>`).join('')}</table>
    <p><b>TLS:</b> ${esc(data.tls)}</p>
    <p><b>Application export integrity check:</b> ${data.export_validation.ok ? 'passed' : 'FAILED'}${data.export_validation.sha256 ? ` · hash ${esc(String(data.export_validation.sha256).slice(0, 16))}` : ''}</p>
    <p><b>Export coverage:</b> ${data.export_validation.complete ? 'all five selected tables fit within the export limits' : 'incomplete: tables were unavailable or exceeded the export limits'}</p>
    <p><small>Scheduled uptime and TLS checks are measured from the deployed app. The application export exports real rows (capped at 500 per table and approximately 1.2 million characters across the rows), hashes them, and verifies the export can be read back with intact counts. It is stored in the same database and does not protect against losing that database. No database restoration was performed. A separate complete backup and recovery test remain necessary. Generated ${esc(data.generated_at)}.</small></p>`;

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
      const body = `Monthly monitoring receipt\n\nChecks:\n${data.checks.map(row => `${row.kind}: ${row.ok}/${row.total} passed`).join('\n')}\n\nTLS: ${data.tls}\nApplication export integrity: ${data.export_validation.ok ? 'passed' : 'FAILED'}\nExport coverage: ${data.export_validation.complete ? 'all selected tables fit' : 'incomplete'}\n\nOpen the receipt:\n${link}\n\nThis is a capped application export stored in the same database. No database restoration was performed; complete backup and recovery remain unverified.\n`;
      const accepted = await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: 'Monthly monitoring receipt', body })));
      if (accepted.some(result => result !== true)) throw new Error('The monthly receipt was not accepted by the owner email connection.');
      return data;
    },
  };
}
