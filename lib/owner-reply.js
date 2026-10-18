import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES } from './frontdesk.js';
import { signOwnerToken } from './owner-documents-core.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

// Keep the owner's new text and drop the quoted original from the reply.
export function cleanReplyBody(text) {
  const lines = String(text || '').split(/\r?\n/);
  const cut = lines.findIndex(line => /^On .+ wrote:$/i.test(line.trim()) || /^From:\s/i.test(line.trim()) || /^-----Original Message-----/i.test(line.trim()));
  const body = (cut >= 0 ? lines.slice(0, cut) : lines)
    .filter(line => !line.trim().startsWith('>'))
    .join('\n')
    .trim();
  return bounded(body, 10000);
}

export function createOwnerReplyHandler({ getDb, mail, env = process.env, now = Date.now } = {}) {
  const db = () => getDb();
  return async request => {
    try {
      if (request.method !== 'POST') return json({ error: 'POST required.' }, 405);
      const secret = env.INBOUND_EMAIL_SECRET;
      if (!secret || request.headers.get('x-legacy-inbound-secret') !== secret) return json({ error: 'Not authorized.' }, 401);
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 64000) return json({ error: 'Too large.' }, 413);
      const payload = JSON.parse(raw);
      const to = String(payload.To || payload.to || '');
      const from = String(payload.From || payload.from || '').toLowerCase();
      const text = String(payload.TextBody || payload.text || payload.body || '');
      if (!OWNER_ADDRESSES.map(address => address.toLowerCase()).includes(from)) return json({ error: 'Sender is not an owner address.' }, 403);
      const match = /reply\+([0-9a-f-]{36})@/i.exec(to);
      if (!match) return json({ error: 'Reply address is invalid.' }, 400);
      const id = match[1];
      const doc = (await db().execute(sql`SELECT * FROM legacy_owner_documents WHERE id=${id}::uuid`)).rows[0];
      if (!doc) return json({ error: 'Document not found.' }, 404);
      if (doc.status !== 'draft') return json({ error: 'Document is not editable.' }, 409);
      const reply = cleanReplyBody(text);
      if (!reply) return json({ error: 'Reply body is empty.' }, 400);
      const content = reply.toUpperCase().startsWith('REPLACE:')
        ? bounded(reply.slice(8).trim(), 10000)
        : bounded(`${doc.content}\n\nOwner edit request (${new Date(now()).toISOString().slice(0, 10)}):\n${reply}`, 10000);
      if (!content) return json({ error: 'The edited content is empty.' }, 400);
      const updated = await db().execute(sql`UPDATE legacy_owner_documents SET content=${content},version=version+1 WHERE id=${id}::uuid AND status='draft' RETURNING version`);
      if (!updated.rows.length) return json({ error: 'Document changed; the reply was not applied.' }, 409);
      const version = updated.rows[0].version;
      const token = signOwnerToken({ id, scope: 'review', exp: now() + 7 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET);
      const origin = new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
      const url = `${origin}/api/frontdesk/document?token=${token}`;
      await mail({ to: from, subject: `Reply applied: ${doc.title}`, body: `Your reply was applied to the draft.\n\n${content}\n\nReview: ${url}` });
      return json({ ok: true, id, version });
    } catch {
      return json({ error: 'The reply could not be applied.' }, 500);
    }
  };
}
