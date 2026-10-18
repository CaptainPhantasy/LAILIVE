import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire('/tmp/lailive-preview-wt/package.json');
const pg = require('pg');

const id = process.argv[2];
if (!process.env.DATABASE_URL && !process.env.DATABASE_URL_UNPOOLED) { console.error('No database URL in the environment.'); process.exit(64); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL, connectionTimeoutMillis: 12000, max: 2 });
try {
  const query = id
    ? pool.query('SELECT id,payload,sha256,rows,created_at FROM legacy_backups WHERE id=$1', [id])
    : pool.query('SELECT id,payload,sha256,rows,created_at FROM legacy_backups ORDER BY created_at DESC LIMIT 1');
  const record = (await query).rows[0];
  if (!record) { console.error('No backup found.'); process.exit(2); }
  const hash = createHash('sha256').update(String(record.payload)).digest('hex');
  const parsed = JSON.parse(String(record.payload));
  const stored = typeof record.rows === 'string' ? JSON.parse(record.rows) : record.rows;
  const report = { id: record.id, created_at: record.created_at, hashIntact: hash === record.sha256, tables: {} };
  let ok = hash === record.sha256;
  for (const [name, data] of Object.entries(parsed.tables || {})) {
    const rows = Array.isArray(data?.rows) ? data.rows.length : null;
    const countOk = data?.truncated ? true : Number(stored?.[name]) === rows;
    const rowsOk = Array.isArray(data?.rows) && data.rows.every(row => row && typeof row === 'object' && !Array.isArray(row));
    report.tables[name] = { stored: stored?.[name] ?? null, exported: rows, truncated: Boolean(data?.truncated), countOk, rowsOk };
    if (!countOk || !rowsOk) ok = false;
  }
  console.log(JSON.stringify({ ...report, ok }, null, 1));
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error('drill failed:', error?.code || '', error?.message || String(error));
  process.exitCode = 1;
} finally { await pool.end(); }
