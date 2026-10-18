import { sql } from 'drizzle-orm';
import { ensureJobsSchema } from './jobs.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

// The owner-session view of the job list. It returns status only; technician
// links stay in email so a signed URL is never stored in the portal.
export function createOwnerJobsHandler({ getDb, requireOwner } = {}) {
  let ready;
  const ensure = () => ready ||= ensureJobsSchema(getDb()).catch(error => { ready = null; throw error; });
  return async request => {
    try {
      if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
      await requireOwner(request);
      await ensure();
      const rows = (await getDb().execute(sql`SELECT job_id, customer_name, service, status, assigned_to, source, created_at FROM legacy_jobs ORDER BY created_at DESC LIMIT 100`)).rows;
      return json({ jobs: rows.map(row => ({ jobId: row.job_id, customer: row.customer_name, service: row.service || '', status: row.status, technician: row.assigned_to || '', source: row.source || '', createdAt: row.created_at })) });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      return json({ error: status === 401 || status === 403 ? error.message : 'The job list could not be loaded.' }, status);
    }
  };
}
