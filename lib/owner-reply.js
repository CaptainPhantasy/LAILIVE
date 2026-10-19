import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { OWNER_ADDRESSES } from './frontdesk.js';
import { documentPdf, signOwnerToken } from './owner-documents-core.js';
import { applyOwnerReplyEdit } from './owner-reply-edit.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

// Keep the owner's new text and drop the quoted original from the reply.
export function cleanReplyBody(text) {
  const lines = String(text || '').split(/\r?\n/);
  const cut = lines.findIndex(line => /^On .+ wrote:$/i.test(line.trim()) || /^From:\s/i.test(line.trim()) || /^-----Original Message-----/i.test(line.trim()));
  const body = (cut >= 0 ? lines.slice(0, cut) : lines)
    .filter(line => !line.trim().startsWith('>'))
    .join('\n')
    .trim();
  return body;
}

function mailbox(value) {
  const raw = String(value || '').trim();
  const match = /^[^<>\r\n]*<([^<>\s]+)>$/.exec(raw);
  const address = match ? match[1] : raw;
  return /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(address) ? address.toLowerCase() : '';
}

export function createOwnerReplyHandler({ getDb, mail, env = process.env, now = Date.now } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_owner_reply_receipts (reply_key text PRIMARY KEY, request_hash text NOT NULL, document uuid NOT NULL, sender text NOT NULL, version integer NOT NULL, changed boolean NOT NULL DEFAULT true, notification text NOT NULL DEFAULT 'pending', notification_started_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw('ALTER TABLE legacy_owner_reply_receipts ADD COLUMN IF NOT EXISTS changed boolean NOT NULL DEFAULT true'));
    await db().execute(sql.raw('ALTER TABLE legacy_owner_reply_receipts ADD COLUMN IF NOT EXISTS notification_started_at timestamptz'));
    await db().execute(sql.raw('ALTER TABLE legacy_owner_reply_receipts ENABLE ROW LEVEL SECURITY'));
  })().catch(error => { ready = null; throw error; });
  const hash = value => createHash('sha256').update(value).digest('hex');
  return async request => {
    try {
      if (request.method !== 'POST') return json({ error: 'POST required.' }, 405);
      const secret = env.INBOUND_EMAIL_SECRET;
      if (!secret || request.headers.get('x-legacy-inbound-secret') !== secret) return json({ error: 'Not authorized.' }, 401);
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 64000) return json({ error: 'Too large.' }, 413);
      let payload;
      try { payload = JSON.parse(raw); } catch { return json({ error: 'Invalid JSON request.' }, 400); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json({ error: 'Invalid email payload.' }, 400);
      const to = mailbox(payload.To || payload.to);
      const from = mailbox(payload.From || payload.from);
      const text = String(payload.TextBody || payload.text || payload.body || '');
      if (!OWNER_ADDRESSES.map(address => address.toLowerCase()).includes(from)) return json({ error: 'Sender is not an owner address.' }, 403);
      const match = /^reply\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@(.+)$/i.exec(to);
      if (!match || match[2] !== (env.FRONTDESK_REPLY_DOMAIN || 'legacyai.space').toLowerCase()) return json({ error: 'Reply address is invalid.' }, 400);
      const id = match[1];
      const reply = cleanReplyBody(text);
      if (!reply) return json({ error: 'Reply body is empty.' }, 400);
      if (reply.length > 10000) return json({ error: 'The reply is too long. The original draft was kept.' }, 413);
      const requestHash = hash(JSON.stringify([id, from, reply]));
      const suppliedMessageId = payload.MessageID || payload.MessageId || payload.message_id;
      const messageId = typeof suppliedMessageId === 'string' ? suppliedMessageId.trim() : '';
      if (!messageId) return json({ error: 'The incoming email Message-ID is required so a delivery retry cannot overwrite a newer correction. The original draft was kept.' }, 400);
      if (messageId.length > 500) return json({ error: 'The incoming email Message-ID exceeds 500 characters. The original draft was kept.' }, 413);
      // Validate the protected review link before changing the document.
      let origin, token;
      try {
        const publicUrl = new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space');
        if (publicUrl.protocol !== 'https:') throw new Error('HTTPS required.');
        origin = publicUrl.origin;
        token = signOwnerToken({ id, scope: 'review', exp: now() + 7 * 86400000 }, env.RECEPTIONIST_SESSION_SECRET);
      } catch { return json({ error: 'The protected review link is not configured. The original draft was kept.' }, 503); }
      await ensure();
      const replyKey = hash(JSON.stringify([from, messageId]));
      let receipt = (await db().execute(sql`SELECT * FROM legacy_owner_reply_receipts WHERE reply_key=${replyKey}`)).rows[0];
      const doc = (await db().execute(sql`SELECT * FROM legacy_owner_documents WHERE id=${id}::uuid`)).rows[0];
      if (!doc) return json({ error: 'Document not found.' }, 404);
      if (receipt && receipt.request_hash !== requestHash) return json({ error: 'This email identifier was already used for another correction.' }, 409);
      let duplicate = Boolean(receipt);
      if (!receipt) {
        if (doc.status !== 'draft') return json({ error: 'Document is not editable.' }, 409);
        const edit = applyOwnerReplyEdit(doc.content, reply);
        if (!edit.ok) return json({ error: edit.error }, 422);
        try { documentPdf(doc.title, edit.content); } catch { return json({ error: 'The corrected document cannot be rendered as a PDF. The original draft was kept.' }, 422); }
        receipt = await db().transaction(async tx => {
          const claim = await tx.execute(sql`INSERT INTO legacy_owner_reply_receipts(reply_key,request_hash,document,sender,version,changed,notification) VALUES (${replyKey},${requestHash},${id}::uuid,${from},${doc.version + (edit.changed ? 1 : 0)},${edit.changed},${edit.changed ? 'pending' : 'not_needed'}) ON CONFLICT DO NOTHING RETURNING *`);
          if (!claim.rows.length) {
            const existing = (await tx.execute(sql`SELECT * FROM legacy_owner_reply_receipts WHERE reply_key=${replyKey}`)).rows[0];
            if (existing?.request_hash !== requestHash) throw Object.assign(new Error('Email identifier conflict.'), { status: 409 });
            duplicate = true;
            return existing;
          }
          const updated = await tx.execute(sql`UPDATE legacy_owner_documents SET content=${edit.content},version=version+${edit.changed ? 1 : 0} WHERE id=${id}::uuid AND status='draft' AND version=${doc.version} RETURNING version`);
          if (!updated.rows.length) throw Object.assign(new Error('Document changed; the reply was not applied. Review the current draft before trying again.'), { status: 409 });
          return claim.rows[0];
        });
      }
      const version = receipt.version;
      const skipReview = current => json({ ok: true, id, version, duplicate, documentVersion: current.version, documentStatus: current.status, reviewSkipped: true, reviewEmailed: receipt.notification === 'sent' });
      if (!receipt.changed) return json({ ok: true, id, version, duplicate, changed: false, documentStatus: doc.status, reviewEmailed: false });
      if (doc.status !== 'draft') return skipReview(doc);
      if (receipt.notification === 'sent') return json({ ok: true, id, version, duplicate, documentStatus: doc.status, reviewEmailed: true });
      const url = `${origin}/api/frontdesk/document?token=${token}`;
      const current = (await db().execute(sql`SELECT title,content,version,status FROM legacy_owner_documents WHERE id=${id}::uuid`)).rows[0];
      if (current.status !== 'draft') return skipReview(current);
      // A bounded claim avoids simultaneous review emails and recovers if a
      // worker stopped after saving the edit. Retries never edit a second time.
      const startedAt = new Date(now()).toISOString(), abandonedBefore = new Date(now() - 5 * 60000).toISOString();
      const notification = await db().execute(sql`UPDATE legacy_owner_reply_receipts SET notification='sending',notification_started_at=${startedAt}::timestamptz WHERE reply_key=${replyKey} AND (notification='pending' OR (notification='sending' AND (notification_started_at IS NULL OR notification_started_at < ${abandonedBefore}::timestamptz))) AND EXISTS (SELECT 1 FROM legacy_owner_documents WHERE id=${id}::uuid AND status='draft') RETURNING reply_key`);
      if (!notification.rows.length) {
        const latest = (await db().execute(sql`SELECT version,status FROM legacy_owner_documents WHERE id=${id}::uuid`)).rows[0];
        if (latest.status !== 'draft') return skipReview(latest);
        return Response.json({ applied: true, id, version, duplicate, reviewEmailed: false, notification: 'in_progress' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } });
      }
      try {
        const accepted = await mail({ to: from, subject: `Reply applied: ${current.title}`, replyTo: `reply+${id}@${env.FRONTDESK_REPLY_DOMAIN || 'legacyai.space'}`, body: `Your correction was applied. Document revision ${current.version}:\n\n${current.content}\n\nOpen the current document and its delivery status:\n${url}\n\nThis review email does not send anything to a customer. The review page shows the latest document status.` });
        if (accepted === false) throw new Error('The owner review email was rejected.');
      } catch {
        await db().execute(sql`UPDATE legacy_owner_reply_receipts SET notification='pending' WHERE reply_key=${replyKey} AND notification='sending' AND notification_started_at=${startedAt}::timestamptz`);
        return json({ error: 'The edit was saved, but review email delivery is unconfirmed. A retry will only retry the owner review email.', applied: true, id, version, reviewEmailed: false }, 502);
      }
      await db().execute(sql`UPDATE legacy_owner_reply_receipts SET notification='sent' WHERE reply_key=${replyKey} AND notification='sending' AND notification_started_at=${startedAt}::timestamptz`);
      return json({ ok: true, id, version, duplicate, reviewEmailed: true });
    } catch (error) {
      return json({ error: error?.status === 409 ? error.message : 'The reply could not be applied.' }, error?.status === 409 ? 409 : 500);
    }
  };
}
