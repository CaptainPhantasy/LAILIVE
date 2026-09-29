import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { HttpError, parse } from './concierge/contracts.js';
import { ownerEmail } from './concierge/config.js';

// The site assistant (an ElevenLabs agent on the website and phone) reports
// escalations here. Every email goes to the owner only: the recipient is fixed
// in this file and never comes from the agent, a caller or a visitor.
export const OWNER_TIME_ZONE = 'America/Indiana/Indianapolis';
const rows = result => result.rows;
const text = max => z.string().trim().max(max);

export const notifyInput = z.object({
  kind: z.enum(['contact_request', 'unanswered_question']),
  channel: z.enum(['web', 'phone']).default('web'),
  visitor_name: text(120).default(''),
  contact: text(200).default(''),
  question: text(1000).default(''),
  summary: text(2000).default(''),
  conversation_id: text(100).default(''),
}).strict().refine(input => input.question || input.summary, 'Include the question or a short summary.');

const STOP = new Set('a an and are be can do does for from have how i if in is it me my of on or our please should so that the this to we what when where which who why will with you your'.split(' '));
export function questionTokens(value) {
  return [...new Set(String(value).toLowerCase().replace(/[^a-z0-9$ ]+/g, ' ').split(/\s+/)
    .filter(word => word && !STOP.has(word)).map(word => word.length <= 3 ? word : word.replace(/ies$/, 'y').replace(/ing$/, '').replace(/(?<!s)s$/, '')))].sort();
}
// Two questions count as the same when most of their meaningful words match.
export function similarQuestions(a, b) {
  const x = questionTokens(a), y = questionTokens(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  const shared = x.filter(word => y.includes(word)).length;
  return Math.min(x.length, y.length) >= 2 && shared / new Set([...x, ...y]).size >= 0.5;
}

export function localParts(date, timeZone = OWNER_TIME_ZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
export function digestSlot(now) {
  const { hour } = localParts(now);
  return hour === 12 ? 'noon' : hour === 18 ? 'evening' : null;
}
// Noon covers since the previous 6 pm update; 6 pm covers since noon.
export const digestSince = (now, slot) => new Date(now.getTime() - (slot === 'noon' ? 18 : 6) * 3600000);

const when = date => new Date(date).toLocaleString('en-US', { timeZone: OWNER_TIME_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const line = (label, value) => value ? `${label}: ${value}` : null;

export function composeAlert(event, related = []) {
  const trending = related.length > 0;
  const who = event.visitor_name || 'A visitor';
  const subject = trending ? `Trending question on legacyai.space: "${event.question.slice(0, 70)}"`
    : event.kind === 'contact_request' ? `${who} wants to reach you (${event.channel === 'phone' ? 'phone' : 'website'})`
    : `The site assistant couldn't answer a question (${event.channel === 'phone' ? 'phone' : 'website'})`;
  const body = [
    trending ? `${related.length + 1} people asked the assistant this today and it had no answer:` : event.kind === 'contact_request' ? 'Someone asked the site assistant to put them in touch with you.' : 'The site assistant could not answer this from the website content.',
    '',
    ...[line('Question', event.question), line('Name', event.visitor_name), line('Contact', event.contact), line('Channel', event.channel === 'phone' ? 'Phone call' : 'Website chat'), line('Summary', event.summary), line('Conversation', event.conversation_id)].filter(Boolean),
    ...(trending ? ['', 'Earlier today:', ...related.map(r => `- ${when(r.created_at)}: ${r.question}${r.contact ? ` (${r.contact})` : ''}`), '', 'Adding the answer to the website or the assistant\'s knowledge base would cover it next time.'] : []),
    '', `Sent ${when(new Date())} by the Legacy AI site assistant. Only you receive these messages.`,
  ];
  return { subject, body: body.join('\n') };
}

export function composeDigest({ slot, since, now, events = [], visitors = [], inquiries = [], conversations = null, notes = [] }) {
  const label = slot === 'noon' ? 'Noon' : '6 pm';
  const contactRequests = events.filter(e => e.kind === 'contact_request'), unanswered = events.filter(e => e.kind === 'unanswered_question');
  const section = (title, items) => items.length ? ['', `${title} (${items.length})`, ...items] : [];
  const body = [
    `${label} update for legacyai.space — ${when(since)} to ${when(now)}.`,
    ...section('People who asked to reach you', contactRequests.map(e => `- ${when(e.created_at)} · ${e.visitor_name || 'No name given'}${e.contact ? ` · ${e.contact}` : ''} · ${e.channel === 'phone' ? 'phone' : 'web'}: ${e.question || e.summary}`)),
    ...section('Questions the assistant could not answer', unanswered.map(e => `- ${when(e.created_at)} · ${e.channel === 'phone' ? 'phone' : 'web'}: ${e.question || e.summary}`)),
    ...section('New inquiries from the site', inquiries.map(i => `- ${when(i.created_at)} · ${i.name}${i.company ? ` (${i.company})` : ''} · ${i.email}: ${String(i.message).replace(/\s+/g, ' ').slice(0, 220)}`)),
    ...section('Visitors who shared contact details', visitors.map(v => `- ${when(v.last_seen)} · ${(v.identifiers || []).map(i => i.value).filter(Boolean).slice(0, 4).join(', ') || 'details on file'} · pages: ${(v.pages || []).slice(-4).join(', ')}`)),
    ...(conversations ? section('Assistant conversations (web and phone)', conversations.map(c => `- ${when(c.start_time_unix_secs * 1000)} · ${Math.round((c.call_duration_secs || 0) / 60 * 10) / 10} min · ${c.call_summary_title || c.status || 'conversation'}`)) : []),
    ...(!events.length && !inquiries.length && !visitors.length && !(conversations?.length) ? ['', 'Quiet stretch: no escalations, inquiries, shared contact details or assistant conversations.'] : []),
    ...(notes.length ? ['', 'Notes', ...notes.map(n => `- ${n}`)] : []),
    '', 'Sent by the Legacy AI site assistant. Only you receive these updates.',
  ];
  const count = contactRequests.length + unanswered.length + inquiries.length;
  return { subject: `${label} update: ${count ? `${count} item${count === 1 ? '' : 's'} need a look` : 'quiet'} · legacyai.space`, body: body.join('\n') };
}

export function createOwnerMailer({ env = process.env, fetcher = fetch } = {}) {
  return async ({ subject, body }) => {
    const url = env.OWNER_NOTIFY_WEBHOOK_URL;
    if (!url) throw new Error('OWNER_NOTIFY_WEBHOOK_URL is not configured.');
    const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: ownerEmail, subject, body }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Owner email webhook returned ${response.status}.`);
    return true;
  };
}

export function createAssistantStore(db) {
  let ready;
  // Keeps the feature working before the migration is applied by hand.
  const ensure = () => ready ||= db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_assistant_events (id uuid PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('contact_request','unanswered_question')), channel text NOT NULL DEFAULT 'web' CHECK (channel IN ('web','phone')), visitor_name text NOT NULL DEFAULT '', contact text NOT NULL DEFAULT '', question text NOT NULL DEFAULT '', summary text NOT NULL DEFAULT '', conversation_id text NOT NULL DEFAULT '', emailed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now())`)).catch(error => { ready = null; throw error; });
  return {
    async saveEvent(e) {
      await ensure();
      const id = randomUUID();
      const row = rows(await db.execute(sql`INSERT INTO legacy_assistant_events(id,kind,channel,visitor_name,contact,question,summary,conversation_id) VALUES (${id}::uuid,${e.kind},${e.channel},${e.visitor_name},${e.contact},${e.question},${e.summary},${e.conversation_id}) RETURNING *`))[0];
      return row;
    },
    async markEmailed(id) { await db.execute(sql`UPDATE legacy_assistant_events SET emailed=true WHERE id=${id}::uuid`); },
    async eventsSince(since) { await ensure(); return rows(await db.execute(sql`SELECT * FROM legacy_assistant_events WHERE created_at >= ${since.toISOString()}::timestamptz ORDER BY created_at LIMIT 200`)); },
    async visitorsSince(since) { return rows(await db.execute(sql`SELECT identifiers,pages,last_seen FROM legacy_visitor_contacts WHERE last_seen >= ${since.toISOString()}::timestamptz ORDER BY last_seen DESC LIMIT 50`)); },
    async inquiriesSince(since) { return rows(await db.execute(sql`SELECT i.created_at,i.message,c.name,c.email,c.company FROM legacy_inquiries i JOIN legacy_contacts c ON c.id=i.contact_id WHERE i.created_at >= ${since.toISOString()}::timestamptz ORDER BY i.created_at DESC LIMIT 50`)); },
  };
}

export async function listAgentConversations({ env = process.env, fetcher = fetch, since }) {
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_AGENT_ID) return null;
  const url = new URL('https://api.elevenlabs.io/v1/convai/conversations');
  url.searchParams.set('agent_id', env.ELEVENLABS_AGENT_ID);
  url.searchParams.set('call_start_after_unix', String(Math.floor(since.getTime() / 1000)));
  url.searchParams.set('page_size', '100');
  const response = await fetcher(url, { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`ElevenLabs returned ${response.status}.`);
  return (await response.json()).conversations || [];
}

function secretMatches(given, expected) {
  if (!expected || typeof given !== 'string') return false;
  const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const safe = value => typeof value === 'string' && /^[A-Za-z0-9_:. -]{1,120}$/.test(value) ? value : undefined;

export function createAssistantHandlers({ getDb, getStore, mail, env = process.env, fetcher = fetch, now = () => new Date() }) {
  const store = () => createAssistantStore(getDb());
  return {
    notify: async request => {
      try {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
        if (!secretMatches(request.headers.get('x-assistant-secret'), env.ASSISTANT_TOOL_SECRET)) throw new HttpError(401, 'Not authorized.');
        if (Number(request.headers.get('content-length') || 0) > 16000) throw new HttpError(413, 'Too large.');
        let body; try { body = JSON.parse(await request.text()); } catch { throw new HttpError(400, 'Invalid JSON request.'); }
        const input = parse(notifyInput, body);
        const time = now(), { date } = localParts(time), expiresAt = new Date(time.getTime() + 2 * 86400000).toISOString();
        // Emailing the owner is the core job; logging and trend detection need the
        // database and are skipped (not fatal) when it is unavailable.
        let saved = { ...input, id: null, created_at: time.toISOString() }, related = [], events = null;
        try {
          // A public agent can be talked into repeat calls; cap the owner's inbox.
          await getStore().consumeLimits([{ key: `assistant-notify:${date}`, limit: 60, expiresAt }]);
          events = store(); saved = await events.saveEvent(input);
        } catch (error) {
          if (error instanceof HttpError && error.status === 429) throw error;
          events = null; console.error('legacy_assistant_store_unavailable', { name: safe(error?.name) });
        }
        if (events && input.kind === 'unanswered_question' && input.question) {
          try {
            const today = (await events.eventsSince(new Date(time.getTime() - 26 * 3600000)))
              .filter(e => e.id !== saved.id && e.kind === 'unanswered_question' && localParts(new Date(e.created_at)).date === date && similarQuestions(e.question, input.question));
            if (today.length) {
              // Key on the day's first matching question so rephrasings share one alert.
              const key = today.reduce((first, e) => new Date(e.created_at) < new Date(first.created_at) ? e : first).id;
              try { await getStore().consumeLimits([{ key: `assistant-trend:${date}:${key}`, limit: 1, expiresAt }]); related = today; }
              catch (error) { if (!(error instanceof HttpError && error.status === 429)) throw error; }
            }
          } catch (error) { console.error('legacy_assistant_trend_unavailable', { name: safe(error?.name) }); }
        }
        let notified = false;
        try { await mail(composeAlert(saved, related)); notified = true; if (events && saved.id) await events.markEmailed(saved.id).catch(() => {}); }
        catch (error) { console.error('legacy_assistant_mail_failure', { message: safe(error?.message) }); }
        return json({ saved: true, notified, trending: related.length > 0, message: notified ? 'Douglas has been sent a message.' : saved.id ? 'The message was saved for Douglas and will appear in his next update.' : 'The message could not be delivered. Use the direct email tool.' });
      } catch (error) {
        if (error instanceof HttpError) return json({ error: error.message }, error.status);
        console.error('legacy_assistant_notify_failure', { name: safe(error?.name) });
        return json({ error: 'Could not record this message.' }, 503);
      }
    },
    digest: async request => {
      try {
        if (!['GET', 'POST'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
        if (!secretMatches(request.headers.get('authorization')?.replace(/^Bearer /, ''), env.CRON_SECRET)) throw new HttpError(401, 'Not authorized.');
        const url = new URL(request.url), time = now(), force = url.searchParams.get('force') === '1';
        const slot = force ? (url.searchParams.get('slot') === 'noon' ? 'noon' : 'evening') : digestSlot(time);
        if (!slot) return json({ skipped: 'Not a digest hour in Indianapolis time.' });
        const { date } = localParts(time), since = digestSince(time, slot), notes = [];
        if (!force) {
          try { await getStore().consumeLimits([{ key: `digest:${date}:${slot}`, limit: 1, expiresAt: new Date(time.getTime() + 2 * 86400000).toISOString() }]); }
          catch (error) { if (error instanceof HttpError && error.status === 429) return json({ skipped: 'Already sent.' }); throw error; }
        }
        const events = store();
        const attempt = async (label, task, fallback) => { try { return await task(); } catch (error) { notes.push(`${label} could not be read this time (${safe(error?.message) || 'error'}).`); return fallback; } };
        const [assistantEvents, visitors, inquiries, conversations] = await Promise.all([
          attempt('Assistant escalations', () => events.eventsSince(since), []),
          attempt('Visitor contacts', () => events.visitorsSince(since), []),
          attempt('Inquiries', () => events.inquiriesSince(since), []),
          attempt('Assistant conversations', () => listAgentConversations({ env, fetcher, since }), null),
        ]);
        if (conversations === null && !notes.some(n => n.startsWith('Assistant conversations'))) notes.push('Add ELEVENLABS_API_KEY in Vercel to include every assistant conversation, not just escalations.');
        const message = composeDigest({ slot, since, now: time, events: assistantEvents, visitors, inquiries, conversations, notes });
        await mail(message);
        return json({ sent: true, slot, subject: message.subject });
      } catch (error) {
        if (error instanceof HttpError) return json({ error: error.message }, error.status);
        console.error('legacy_digest_failure', { name: safe(error?.name), message: safe(error?.message) });
        return json({ error: 'The digest could not be sent.' }, 503);
      }
    },
  };
}
