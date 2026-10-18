import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES, frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { signOwnerToken } from './owner-documents-core.js';
import { createContentDrafter } from './content-writer.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const CHANNELS = ['blog', 'email', 'social'];
const ZONE = 'America/Indianapolis';
function localDate(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

// A seasonal rule creates one owner-reviewed content draft per year on a chosen
// date. It publishes nothing and fires at most once per rule per year.
export function createSeasonal({ getDb, mail, env = process.env, now = Date.now, draft = createContentDrafter({ env }) } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_seasonal_rules (id uuid PRIMARY KEY, name text NOT NULL, month integer NOT NULL, day integer NOT NULL, channel text NOT NULL, topic text NOT NULL, active boolean NOT NULL DEFAULT true, last_fired_year integer, created_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_seasonal_runs (id uuid PRIMARY KEY, rule uuid NOT NULL, draft uuid NOT NULL, fired_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_content_drafts (id uuid PRIMARY KEY, topic text NOT NULL, channel text NOT NULL, angle text NOT NULL DEFAULT '', draft text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'draft', version integer NOT NULL DEFAULT 1, decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`));
    for (const table of ['legacy_seasonal_rules', 'legacy_seasonal_runs']) await db().execute(sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
  })().catch(error => { ready = null; throw error; });
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const link = id => `${origin()}/api/frontdesk/content?token=${signOwnerToken({ id, scope: 'content', exp: now() + 14 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET)}`;

  async function run() {
    await ensure();
    const { year, month, day } = localDate(now);
    const rules = (await db().execute(sql`SELECT * FROM legacy_seasonal_rules WHERE active AND month=${month} AND day=${day} AND (last_fired_year IS NULL OR last_fired_year<>${year})`)).rows;
    let fired = 0; const created = [];
    for (const rule of rules) {
      // Generate first, then claim and write in one transaction. Generating after
      // the claim meant a failed insert left the rule marked fired for the year,
      // skipping the campaign permanently.
      let body = '', generated = true;
      try { body = bounded(await draft({ topic: rule.topic, channel: rule.channel, angle: rule.name }), 8000); }
      catch { generated = false; }
      const draftId = randomUUID();
      const claimed = await db().transaction(async tx => {
        const claim = await tx.execute(sql`UPDATE legacy_seasonal_rules SET last_fired_year=${year} WHERE id=${rule.id}::uuid AND (last_fired_year IS NULL OR last_fired_year<>${year}) RETURNING id`);
        if (!claim.rows.length) return false;
        await tx.execute(sql`INSERT INTO legacy_content_drafts(id,topic,channel,angle,draft) VALUES (${draftId}::uuid,${rule.topic},${rule.channel},${rule.name},${body})`);
        await tx.execute(sql`INSERT INTO legacy_seasonal_runs(id,rule,draft) VALUES (${randomUUID()}::uuid,${rule.id}::uuid,${draftId}::uuid)`);
        return true;
      });
      if (!claimed) continue;
      fired++;
      created.push({ rule: rule.name, draft: draftId, generated });
      try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Seasonal draft ready: ${rule.topic}`, body: `The seasonal rule "${rule.name}" fired for ${year}.\n\n${body || 'No draft was generated; write it on the review page.'}\n\nReview and approve:\n${link(draftId)}\n\nNothing was published.` }))); } catch { /* the draft stands even when mail fails */ }
    }
    return { fired, created, date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
  }

  return async request => {
    try {
      await ensure();
      if (request.method !== 'POST') return json({ error: 'POST required.' }, 405);
      if (Number(request.headers.get('content-length') || 0) > 8000) return json({ error: 'Too large.' }, 413);
      if (!env.SEASONAL_SECRET && !env.RECEPTIONIST_WEBHOOK_SECRET) return json({ error: 'Not authorized.' }, 401);
      if (!frontdeskSecret(request).some(value => secretMatches(value, env.SEASONAL_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 8000) return json({ error: 'Too large.' }, 413);
      const input = JSON.parse(raw);
      if (input.action === 'run') return json(await run());
      if (input.action === 'list') return json({ rules: (await db().execute(sql`SELECT * FROM legacy_seasonal_rules ORDER BY month, day`)).rows });
      if (input.action && input.action !== 'add') return json({ error: 'Unknown action.' }, 400);
      const name = bounded(input.name, 120), topic = bounded(input.topic, 300), channel = bounded(input.channel, 20) || 'blog';
      const month = Number(input.month), day = Number(input.day);
      if (!name || topic.length < 8) return json({ error: 'A rule name and a topic of at least 8 characters are required.' }, 400);
      if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 28) return json({ error: 'Choose a month and a day from 1 to 28.' }, 400);
      if (!CHANNELS.includes(channel)) return json({ error: 'Channel must be blog, email, or social.' }, 400);
      const id = randomUUID();
      await db().execute(sql`INSERT INTO legacy_seasonal_rules(id,name,month,day,channel,topic) VALUES (${id}::uuid,${name},${month},${day},${channel},${topic})`);
      return json({ ok: true, id, name, month, day, channel, topic });
    } catch { return json({ error: 'The seasonal rule could not be completed.' }, 500); }
  };
}
