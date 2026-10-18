import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES, frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const text = html => String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Watches public competitor pages the owner names. It stores a hash of the
// visible text and alerts on change; it never treats a change as good or bad.
export function createCompetitorWatch({ getDb, mail, env = process.env, now = Date.now, fetcher = fetch } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_competitor_sources (id uuid PRIMARY KEY, url text NOT NULL UNIQUE, label text NOT NULL DEFAULT '', last_hash text NOT NULL DEFAULT '', last_checked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_competitor_changes (id bigserial PRIMARY KEY, source uuid NOT NULL, old_hash text NOT NULL, new_hash text NOT NULL, detected_at timestamptz NOT NULL DEFAULT now())`));
    for (const table of ['legacy_competitor_sources', 'legacy_competitor_changes']) await db().execute(sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
  })().catch(error => { ready = null; throw error; });
  const normalizeUrl = value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$)/i.test(url.hostname)) throw new Error('A public https page is required.');
    return url.href;
  };
  async function fetchHash(url) {
    const response = await fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`The page returned ${response.status}.`);
    const body = await response.text();
    if (body.length > 2000000) throw new Error('The page is too large to watch.');
    return createHash('sha256').update(text(body)).digest('hex');
  }

  async function check() {
    await ensure();
    const sources = (await db().execute(sql`SELECT * FROM legacy_competitor_sources ORDER BY created_at LIMIT 25`)).rows;
    let checked = 0, changed = 0; const failures = [];
    for (const source of sources) {
      try {
        const hash = await fetchHash(source.url);
        checked++;
        if (!source.last_hash) {
          await db().execute(sql`UPDATE legacy_competitor_sources SET last_hash=${hash},last_checked_at=now() WHERE id=${source.id}::uuid`);
          continue;
        }
        if (hash !== source.last_hash) {
          await db().execute(sql`INSERT INTO legacy_competitor_changes(source,old_hash,new_hash) VALUES (${source.id}::uuid,${source.last_hash},${hash})`);
          await db().execute(sql`UPDATE legacy_competitor_sources SET last_hash=${hash},last_checked_at=now() WHERE id=${source.id}::uuid`);
          changed++;
          try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Competitor page changed: ${source.label || source.url}`, body: `${source.url}\n\nThe visible text changed since the last check. This is a change notice, not a judgment.\n\nReview it when you have a moment.` }))); } catch { /* the change is recorded even when mail fails */ }
        } else {
          await db().execute(sql`UPDATE legacy_competitor_sources SET last_checked_at=now() WHERE id=${source.id}::uuid`);
        }
      } catch (error) { failures.push({ url: source.url, error: String(error?.message || 'check failed').slice(0, 120) }); }
    }
    return { checked, changed, failures };
  }

  return async request => {
    try {
      await ensure();
      if (request.method !== 'POST') return json({ error: 'POST required.' }, 405);
      if (Number(request.headers.get('content-length') || 0) > 8000) return json({ error: 'Too large.' }, 413);
      if (!env.COMPETITOR_SECRET && !env.RECEPTIONIST_WEBHOOK_SECRET) return json({ error: 'Not authorized.' }, 401);
      if (!frontdeskSecret(request).some(value => secretMatches(value, env.COMPETITOR_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 8000) return json({ error: 'Too large.' }, 413);
      const input = JSON.parse(raw);
      if (input.action === 'check') return json(await check());
      if (input.action && input.action !== 'add') return json({ error: 'Unknown action.' }, 400);
      let url;
      try { url = normalizeUrl(bounded(input.url, 500)); } catch (error) { return json({ error: error.message }, 400); }
      const label = bounded(input.label, 120);
      if ((await db().execute(sql`SELECT 1 FROM legacy_competitor_sources WHERE url=${url}`)).rows.length) return json({ error: 'That page is already watched.' }, 409);
      const hash = await fetchHash(url);
      const id = randomUUID();
      await db().execute(sql`INSERT INTO legacy_competitor_sources(id,url,label,last_hash,last_checked_at) VALUES (${id}::uuid,${url},${label},${hash},now())`);
      return json({ ok: true, id, url, label, seeded: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const safe = /https|page|large|already|public/i.test(message) ? message : 'The competitor watch could not be completed.';
      return json({ error: safe }, 400);
    }
  };
}
