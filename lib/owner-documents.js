import { ownerPinHash } from './owner-pin.js';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { frontdeskSecret, OWNER_ADDRESSES, OWNER_NUMBER } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { signOwnerToken, readOwnerToken, verifyOwnerPin, documentPdf } from './owner-documents-core.js';
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const swml = text => json({ version: '1.0.0', sections: { main: [{ play: `say:${text}` }, { hangup: {} }] } });
export function createOwnerDocumentHandler({ getDb, mail, env = process.env, now = Date.now }) {
  let ready;
  const db = () => getDb();
  const ensure = async () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_owner_documents (id uuid PRIMARY KEY, call_id text NOT NULL, kind text NOT NULL, title text NOT NULL, content text NOT NULL, recipient text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'draft', version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz)`));
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_owner_pin_attempts (call_id text PRIMARY KEY, attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now())`));
    await db().execute(sql.raw('ALTER TABLE legacy_owner_documents ENABLE ROW LEVEL SECURITY'));
    await db().execute(sql.raw('ALTER TABLE legacy_owner_pin_attempts ENABLE ROW LEVEL SECURITY'));
  })().catch(error => { ready = null; throw error; });
  const token = (payload, ttl) => signOwnerToken({ ...payload, exp: now() + ttl }, env.RECEPTIONIST_SESSION_SECRET);
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const documentUrl = (id, scope = 'review') => `${origin()}/api/frontdesk/document?token=${token({ id, scope }, 7 * 86400000)}`;
  const getDocument = async id => (await db().execute(sql`SELECT * FROM legacy_owner_documents WHERE id=${id}::uuid`)).rows[0];
  return {
    owner: async request => {
      try {
        if (request.method !== 'POST') return json({ error: 'POST required.' }, 405);
        const requestSession = readOwnerToken(new URL(request.url).searchParams.get('session'), env.RECEPTIONIST_SESSION_SECRET, now());
        if (!requestSession && !frontdeskSecret(request).some(value => secretMatches(value, env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
        if (Number(request.headers.get('content-length') || 0) > 16000) return json({ error: 'Too large.' }, 413);
        const raw = await request.text(); if (Buffer.byteLength(raw) > 16000) return json({ error: 'Too large.' }, 413);
        const input = JSON.parse(raw);
        await ensure();
        // Native prompt digits arrive directly from SWML; never expose this value
        // in an AI prompt, call summary, document, response, or application log.
        if (input.vars?.prompt_value !== undefined) {
          if (!frontdeskSecret(request).some(value => secretMatches(value, env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
          const callId = bounded(input.call?.call_id || input.call?.id, 120);
          const caller = bounded(input.call?.from, 40);
          const configuredPin = (await ownerPinHash(db())) || env.FRONTDESK_OWNER_PIN_HASH;
          if (!configuredPin || !callId || caller !== OWNER_NUMBER) return swml('Owner access is unavailable. Please call Douglas directly.');
          const attempts = await db().execute(sql`INSERT INTO legacy_owner_pin_attempts(call_id,attempts) VALUES (${callId},1) ON CONFLICT(call_id) DO UPDATE SET attempts=legacy_owner_pin_attempts.attempts+1 RETURNING attempts`);
          const daily = (await db().execute(sql`SELECT sum(attempts)::integer AS attempts FROM legacy_owner_pin_attempts WHERE created_at > now() - interval '1 day'`)).rows[0]?.attempts || 0;
          if (attempts.rows[0]?.attempts > 3 || daily > 20 || !verifyOwnerPin(input.vars.prompt_value, configuredPin)) return swml('Owner access was not verified. Please call Douglas directly.');
          const session = token({ callId, scope: 'dictate' }, 10 * 60000);
          return json({ version: '1.0.0', sections: { main: [{ unset: ['prompt_value', 'prompt_value_raw'] }, { ai: {
            languages: [{ name: 'English', code: 'en-US', voice: 'openai.alloy' }],
            prompt: { text: 'You are Darla speaking to verified owner Douglas. Collect a field report, quote, invoice draft, or question for The Board. Do not add facts or prices. Confirm dictated wording and intended customer email. Invoices are MANUAL: draft only, Net 7, no service tax per owner instructions. Call save_owner_draft once after confirmation. Tell Douglas the result accurately. A Board request is captured for review; no Board analysis is generated here.' },
            SWAIG: { functions: [{ function: 'save_owner_draft', description: 'Save confirmed owner dictation as a draft and email owner review link. Does not send to customer.', web_hook_url: `${origin()}/api/frontdesk/owner?session=${session}`, parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['field_report', 'quote', 'invoice', 'board_request'] }, title: { type: 'string' }, content: { type: 'string' }, recipient: { type: 'string' } }, required: ['kind', 'title', 'content'] } }] },
          } }] } });
        }
        const session = requestSession;
        const callId = bounded(input.call_id || input.call?.call_id, 120);
        if (!session || session.scope !== 'dictate' || session.callId !== callId) return json({ response: 'Owner verification is required. No draft was saved.' }, 401);
        const args = input.argument?.parsed?.[0] || input.argument?.parsed || input.arguments || {};
        if (!['field_report', 'quote', 'invoice', 'board_request'].includes(args.kind)) return json({ response: 'A valid document type is required.' }, 400);
        const content = bounded(args.content, 10000), title = bounded(args.title, 160), recipient = bounded(args.recipient, 254);
        if (!title || !content || (recipient && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))) return json({ response: 'The title, dictation, or recipient is invalid.' }, 400);
        // Stable call+content identity prevents repeated SWAIG submissions duplicating a draft.
        const digest = createHash('sha256').update(`${callId}:${args.kind}:${title}:${content}:${recipient}`).digest('hex');
        const id = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
        const created = await db().execute(sql`INSERT INTO legacy_owner_documents(id,call_id,kind,title,content,recipient) VALUES (${id}::uuid,${callId},${args.kind},${title},${content},${recipient}) ON CONFLICT DO NOTHING RETURNING id`);
        let emailed = false;
        if (created.rows.length) {
          const url = documentUrl(id);
          const results = await Promise.allSettled(OWNER_ADDRESSES.map(to => mail({ to, subject: `Draft for approval: ${title}`, body: `Your ${args.kind.replaceAll('_', ' ')} was saved.\n\n${content}\n\nReview, edit, download PDF, or approve customer delivery:\n${url}\n\nNothing has been sent to a customer.${args.kind === 'board_request' ? '\nBoard analysis has NOT been generated; this is your captured question.' : ''}` })));
          // The owner is only told the link was emailed when every destination has it;
          // a partial delivery must not be reported as complete.
          emailed = results.every(result => result.status === 'fulfilled');
        }
        return json({ response: created.rows.length ? `Your draft was saved.${emailed ? ' The review link was emailed.' : ' Review email failed; the draft remains saved.'} Nothing was sent to the customer.` : 'This draft was already saved; no duplicate was created.' });
      } catch { return json({ response: 'The owner action failed. No customer delivery is confirmed.' }, 500); }
    },
    document: async request => {
      try {
        const url = new URL(request.url), access = readOwnerToken(url.searchParams.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
        if (!access || !['review', 'download'].includes(access.scope) || !/^[a-f0-9-]{36}$/.test(access.id || '')) return json({ error: 'Review link is invalid or expired.' }, 401);
        await ensure(); let doc = await getDocument(access.id);
        if (!doc) return json({ error: 'Document not found.' }, 404);
        if (request.method === 'POST') {
          if (access.scope !== 'review' || doc.status !== 'draft') return json({ error: 'Document is not editable.' }, 409);
          if (Number(request.headers.get('content-length') || 0) > 20000) return json({ error: 'Too large.' }, 413);
          const form = await request.formData();
          if (form.get('action') === 'edit') {
            const content = bounded(form.get('content'), 10000); if (!content) return json({ error: 'Content required.' }, 400);
            const updated = await db().execute(sql`UPDATE legacy_owner_documents SET content=${content},version=version+1 WHERE id=${doc.id}::uuid AND status='draft' RETURNING id`);
            if (!updated.rows.length) return json({ error: 'The document changed; reload before saving.' }, 409);
          } else if (form.get('action') === 'approve') {
            if (!doc.recipient || doc.kind === 'board_request') return json({ error: 'Customer email is required; Board requests are owner-only.' }, 400);
            const submitted = bounded(form.get('content'), 10000);
            if (submitted !== doc.content) return json({ error: 'Save your edits before approving.' }, 409);
            const claim = await db().execute(sql`UPDATE legacy_owner_documents SET status='sending' WHERE id=${doc.id}::uuid AND status='draft' AND version=${doc.version} RETURNING id`);
            if (!claim.rows.length) return json({ error: 'Delivery already started.' }, 409);
            try {
              await mail({ to: doc.recipient, subject: doc.title, body: `${doc.title}\nLegacy AI LLC\n\n${doc.content}\n\nDownload PDF: ${documentUrl(doc.id, 'download')}` });
              await db().execute(sql`UPDATE legacy_owner_documents SET status='sent',delivered_at=now() WHERE id=${doc.id}::uuid`);
            } catch { return json({ error: 'Delivery outcome is uncertain. The draft is preserved and locked against duplicate sends; inspect the email provider before retrying.' }, 502); }
          } else return json({ error: 'Invalid action.' }, 400);
          return Response.redirect(url.href, 303);
        }
        if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
        if (url.searchParams.get('pdf') === '1' || access.scope === 'download') return new Response(documentPdf(doc.title, doc.content), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="LegacyAI-${doc.kind}-${doc.id}.pdf"`, 'Cache-Control': 'no-store' } });
        return new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legacy AI draft review</title><style>body{font:18px system-ui;max-width:800px;margin:32px auto;padding:16px}textarea{box-sizing:border-box;width:100%;min-height:400px;font:16px system-ui}button,a{display:inline-block;padding:12px;margin:8px 4px}p{overflow-wrap:anywhere}</style><h1>${esc(doc.title)}</h1><p>Legacy AI LLC · ${esc(doc.kind)} · ${esc(doc.status)}</p><p>Customer: ${esc(doc.recipient || 'Not supplied')}</p><form method="post"><textarea name="content" maxlength="10000">${esc(doc.content)}</textarea><button name="action" value="edit" ${doc.status !== 'draft' ? 'disabled' : ''}>Save changes</button><button name="action" value="approve" ${doc.status !== 'draft' || !doc.recipient || doc.kind === 'board_request' ? 'disabled' : ''}>Approve and email customer</button></form><a href="${esc(url.href)}&amp;pdf=1">Download PDF</a><p>Invoices are manual drafts; no Stripe invoice or payment is created.</p></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });
      } catch { return json({ error: 'Document action failed; no customer delivery is confirmed.' }, 500); }
    },
  };
}
