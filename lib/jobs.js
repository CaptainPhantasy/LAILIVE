import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES, frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { signOwnerToken, readOwnerToken } from './owner-documents-core.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const JOB_STATUSES = ['scheduled', 'en_route', 'on_site', 'working', 'done'];
const nextStatus = status => JOB_STATUSES[JOB_STATUSES.indexOf(status) + 1] || null;
const page = (html, status = 200) => new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legacy AI job</title><style>body{font:18px system-ui;max-width:640px;margin:24px auto;padding:16px}h1{font-size:1.4em}ol{padding-left:1.2em}button,a.button{display:block;width:100%;box-sizing:border-box;padding:16px;margin:10px 0;font:18px system-ui;border-radius:8px;border:1px solid #ccc;background:#fff}button:hover{background:#f2f2f2}p{overflow-wrap:anywhere}</style>${html}</html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });

// A technician opens one signed link per job. Each tap advances exactly one step
// and writes a receipt; completion emails the owners once.
export function createJobHandler({ getDb, mail, env = process.env, now = Date.now } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_jobs (id uuid PRIMARY KEY, job_id text NOT NULL UNIQUE, customer_name text NOT NULL, customer_phone text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '', service text NOT NULL DEFAULT '', assigned_to text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '', source text NOT NULL DEFAULT '', status text NOT NULL, scheduled_at timestamptz, done_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw(`ALTER TABLE legacy_jobs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT ''`));
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_job_events (id bigserial PRIMARY KEY, job uuid NOT NULL, status text NOT NULL, detail text, created_at timestamptz NOT NULL DEFAULT now())`));
    for (const table of ['legacy_jobs', 'legacy_job_events']) await db().execute(sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
  })().catch(error => { ready = null; throw error; });
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const link = id => `${origin()}/api/frontdesk/jobs?token=${signOwnerToken({ id, scope: 'job', exp: now() + 7 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET)}`;
  const getRow = async id => (await db().execute(sql`SELECT * FROM legacy_jobs WHERE id=${id}::uuid`)).rows[0];
  const getByJobId = async jobId => (await db().execute(sql`SELECT * FROM legacy_jobs WHERE job_id=${jobId}`)).rows[0];
  const listLink = () => `${origin()}/api/frontdesk/jobs?list=${signOwnerToken({ scope: 'jobs-list', exp: now() + 7 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET)}`;
  const listView = rows => page(`<h1>Jobs</h1>${rows.length ? `<ol>${rows.map(row => `<li><b>${esc(row.customer_name)}</b> · ${esc(row.status.replace('_', ' '))}${row.assigned_to ? ` · ${esc(row.assigned_to)}` : ''}<br><small>${esc(row.job_id)} · ${esc(row.service || 'service not supplied')}</small><br><a class="button" href="${esc(link(row.id))}">Open job</a></li>`).join('')}</ol>` : '<p>No jobs yet.</p>'}<p><small>This link is owner-only and expires in seven days. Nothing is emailed to a customer.</small></p>`);

  const view = (row, tokenValue, message = '') => {
    const next = nextStatus(row.status);
    return page(`<h1>${esc(row.customer_name)}</h1>${message ? `<p><b>${esc(message)}</b></p>` : ''}
      <p>${esc(row.service || 'Service not supplied')}<br>${esc(row.address || 'Address not supplied')}<br>${esc(row.customer_phone || '')}</p>
      <p>Status: <b>${esc(row.status.replace('_', ' '))}</b>${row.assigned_to ? ` · ${esc(row.assigned_to)}` : ''}</p>
      ${next ? `<form method="post"><input type="hidden" name="token" value="${esc(tokenValue)}"><button name="action" value="advance">Mark ${esc(next.replace('_', ' '))}</button></form>` : '<p>This job is complete.</p>'}
      <p><small>Every step is recorded. Nothing is sent to the customer by this page.</small></p>`);
  };

  async function advance(row, tokenValue) {
    const next = nextStatus(row.status);
    if (!next) return view(row, tokenValue, 'This job is already complete.');
    const updated = await db().execute(sql`UPDATE legacy_jobs SET status=${next},updated_at=now(),done_at=${next === 'done' ? sql`now()` : sql`done_at`} WHERE id=${row.id}::uuid AND status=${row.status} RETURNING *`);
    if (!updated.rows.length) return view(await getRow(row.id), tokenValue, 'Another update landed first; this page was refreshed.');
    const fresh = updated.rows[0];
    try { await db().execute(sql`INSERT INTO legacy_job_events(job,status) VALUES (${row.id}::uuid,${next})`); } catch { /* the status is authoritative */ }
    if (next === 'done') {
      try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Job complete: ${fresh.customer_name}`, body: `Job ${fresh.job_id} is marked complete.\n\n${fresh.customer_name}\n${fresh.service}\n${fresh.address}\n${fresh.assigned_to ? `Technician: ${fresh.assigned_to}` : ''}\n\nThis is a status record, not a customer invoice.` }))); } catch { /* completion stands even when mail fails */ }
    }
    return view(fresh, tokenValue, next === 'done' ? 'Job marked complete.' : `Marked ${next.replace('_', ' ')}.`);
  }

  return async request => {
    try {
      await ensure();
      const url = new URL(request.url);
      if (request.method === 'GET') {
        if (url.searchParams.has('list')) {
          const access = readOwnerToken(url.searchParams.get('list'), env.RECEPTIONIST_SESSION_SECRET, now());
          if (!access || access.scope !== 'jobs-list') return page('<h1>This link is not valid</h1>', 401);
          const rows = (await db().execute(sql`SELECT * FROM legacy_jobs ORDER BY created_at DESC LIMIT 100`)).rows;
          return listView(rows);
        }
        const access = readOwnerToken(url.searchParams.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
        if (!access || access.scope !== 'job' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
        const row = await getRow(access.id);
        if (!row) return page('<h1>Job not found</h1>', 404);
        return view(row, url.searchParams.get('token'));
      }
      if (request.method !== 'POST') return json({ error: 'GET or POST required.' }, 405);
      if (Number(request.headers.get('content-length') || 0) > 16000) return json({ error: 'Too large.' }, 413);
      if (request.headers.get('content-type')?.includes('application/json')) {
        if (!env.JOBS_SECRET && !env.RECEPTIONIST_WEBHOOK_SECRET) return json({ error: 'Not authorized.' }, 401);
        if (!frontdeskSecret(request).some(value => secretMatches(value, env.JOBS_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 16000) return json({ error: 'Too large.' }, 413);
        const input = JSON.parse(raw);
        if (input.action === 'list') {
          const listUrl = listLink();
          try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: 'Job list link', body: `Owner-only job list, valid for seven days:\n${listUrl}\n\nNothing was sent to a customer.` }))); } catch { /* the link is still returned */ }
          return json({ ok: true, url: listUrl });
        }
        if (input.action && input.action !== 'create') return json({ error: 'Unknown action.' }, 400);
        const jobId = bounded(input.job_id, 64), name = bounded(input.customer_name, 120);
        if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(jobId) || !name) return json({ error: 'A job id and customer name are required.' }, 400);
        if (await getByJobId(jobId)) return json({ error: 'A job with that id already exists.' }, 409);
        const id = randomUUID();
        await db().execute(sql`INSERT INTO legacy_jobs(id,job_id,customer_name,customer_phone,address,service,assigned_to,notes,source,status,scheduled_at) VALUES (${id}::uuid,${jobId},${name},${bounded(input.customer_phone, 40)},${bounded(input.address, 200)},${bounded(input.service, 120)},${bounded(input.assigned_to, 120)},${bounded(input.notes, 1000)},${bounded(input.source, 120)},'scheduled',${input.scheduled_at ? String(input.scheduled_at) : null}::timestamptz)`);
        try { await db().execute(sql`INSERT INTO legacy_job_events(job,status) VALUES (${id}::uuid,'scheduled')`); } catch { /* the job row is authoritative */ }
        const jobLink = link(id);
        try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Job created: ${name}`, body: `A job was created and the technician link is ready.\n\n${jobId}\n${name}\n${bounded(input.service, 120)}\n${bounded(input.address, 200)}\n\nTechnician page:\n${jobLink}\n\nNothing was sent to the customer.` }))); } catch { /* the job stands even when mail fails */ }
        return json({ ok: true, id, job_id: jobId, status: 'scheduled' });
      }
      const form = await request.formData();
      const access = readOwnerToken(form.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
      if (!access || access.scope !== 'job' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
      const row = await getRow(access.id);
      if (!row) return page('<h1>Job not found</h1>', 404);
      if (form.get('action') !== 'advance') return page('<h1>Unknown action</h1>', 400);
      return advance(row, form.get('token'));
    } catch { return json({ error: 'The job action could not be completed.' }, 500); }
  };
}
