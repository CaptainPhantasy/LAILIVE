import { createHmac, createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { OWNER_ADDRESSES } from './frontdesk.js';
import { signOwnerToken, readOwnerToken, documentPdf } from './owner-documents-core.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (html, status = 200) => new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legacy AI sign-off</title><style>body{font:18px system-ui;max-width:720px;margin:24px auto;padding:16px}h1{font-size:1.4em}pre{white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:8px}input[type=text]{box-sizing:border-box;width:100%;padding:12px;font:18px system-ui;margin:8px 0}button,a.button{display:block;width:100%;box-sizing:border-box;padding:16px;margin:8px 0;font:18px system-ui;border-radius:8px;border:1px solid #ccc;background:#fff}label{display:block;margin:12px 0}p{overflow-wrap:anywhere}</style>${html}</html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });

// The customer types their name to accept a delivered document. This records a
// signature receipt and a signed PDF; it does not use a third-party signing service.
export function createSignoffHandler({ getDb, mail, env = process.env, now = Date.now } = {}) {
  const db = () => getDb();
  let ready;
  const ensure = () => ready ||= (async () => {
    await db().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_document_signatures (document uuid PRIMARY KEY, signer_name text NOT NULL, signed_at timestamptz NOT NULL DEFAULT now(), signature_hash text NOT NULL, user_agent text NOT NULL DEFAULT '')`));
    await db().execute(sql.raw('ALTER TABLE legacy_document_signatures ENABLE ROW LEVEL SECURITY'));
  })().catch(error => { ready = null; throw error; });
  const getDocument = async id => (await db().execute(sql`SELECT * FROM legacy_owner_documents WHERE id=${id}::uuid`)).rows[0];
  const getSignature = async id => (await db().execute(sql`SELECT * FROM legacy_document_signatures WHERE document=${id}::uuid`)).rows[0];
  const signedPdf = (doc, signature) => documentPdf(doc.title, `${doc.content}\n\nSigned by ${signature.signer_name} on ${new Date(signature.signed_at).toISOString()}\nSignature record ${String(signature.signature_hash).slice(0, 16)}`);

  const signedPage = (doc, tokenValue) => page(`<h1>Signed</h1><p><b>${esc(doc.title)}</b></p><p>This document was signed by the customer on record. Nothing else is required.</p><p><a class="button" href="?token=${encodeURIComponent(tokenValue)}&amp;pdf=1">Download the signed PDF</a></p>`);
  const signPage = (doc, tokenValue) => page(`<h1>${esc(doc.title)}</h1><p>Legacy AI LLC</p><pre>${esc(doc.content)}</pre>
    <form method="post"><input type="hidden" name="token" value="${esc(tokenValue)}"><input type="hidden" name="action" value="sign">
    <label>Type your full name to sign <input type="text" name="name" maxlength="120" autocomplete="name" required></label>
    <label><input type="checkbox" name="agree" value="yes" required> I approve this work and accept this document.</label>
    <button>Sign this document</button></form>
    <p><small>Your name and the time are recorded as the signature. This page is not a notary service.</small></p>`);

  return async request => {
    try {
      await ensure();
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const access = readOwnerToken(url.searchParams.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
        if (!access || access.scope !== 'signoff' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
        const doc = await getDocument(access.id);
        if (!doc) return page('<h1>Document not found</h1>', 404);
        const signature = await getSignature(doc.id);
        if (signature) {
          if (url.searchParams.get('pdf') !== '1') return signedPage(doc, url.searchParams.get('token'));
          try { return new Response(signedPdf(doc, signature), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="LegacyAI-signed-${doc.id}.pdf"`, 'Cache-Control': 'no-store' } }); }
          catch { return page('<h1>The signed PDF cannot be rendered</h1>', 400); }
        }
        if (doc.status !== 'sent') return page('<h1>This document is not ready to sign</h1><p>The owner has not delivered it yet.</p>', 409);
        return signPage(doc, url.searchParams.get('token'));
      }
      if (request.method !== 'POST') return json({ error: 'GET or POST required.' }, 405);
      if (Number(request.headers.get('content-length') || 0) > 16000) return json({ error: 'Too large.' }, 413);
      const form = await request.formData();
      const access = readOwnerToken(form.get('token'), env.RECEPTIONIST_SESSION_SECRET, now());
      if (!access || access.scope !== 'signoff' || !/^[a-f0-9-]{36}$/.test(access.id || '')) return page('<h1>This link is not valid</h1>', 401);
      if (form.get('action') !== 'sign') return page('<h1>Unknown action</h1>', 400);
      const doc = await getDocument(access.id);
      if (!doc) return page('<h1>Document not found</h1>', 404);
      if (await getSignature(doc.id)) return signedPage(doc, form.get('token'));
      if (doc.status !== 'sent') return page('<h1>This document is not ready to sign</h1>', 409);
      const name = bounded(form.get('name'), 120);
      if (name.length < 2 || form.get('agree') !== 'yes') return page('<h1>A name and the approval checkbox are required</h1>', 400);
      if (/[^\x09\x0a\x0d\x20-\xff]/.test(name)) return page('<h1>Use Latin characters in the signature name</h1>', 400);
      const signedAt = new Date(now()).toISOString();
      const hash = createHmac('sha256', env.RECEPTIONIST_SESSION_SECRET).update(`${doc.id}:${name}:${signedAt}:${createHash('sha256').update(String(doc.content)).digest('hex')}`).digest('hex');
      const agent = bounded(request.headers.get('user-agent'), 200);
      // The status change and the signature row commit together. A partial commit
      // would leave the document marked signed with no signature to show for it,
      // and no later attempt could repair it because the status is no longer 'sent'.
      let signed = true;
      await db().transaction(async tx => {
        const claimed = await tx.execute(sql`UPDATE legacy_owner_documents SET status='signed', delivered_at=coalesce(delivered_at, now()) WHERE id=${doc.id}::uuid AND status='sent' RETURNING id`);
        if (!claimed.rows.length) { signed = false; return; }
        await tx.execute(sql`INSERT INTO legacy_document_signatures(document,signer_name,signed_at,signature_hash,user_agent) VALUES (${doc.id}::uuid,${name},${signedAt}::timestamptz,${hash},${agent})`);
      });
      if (!signed) return page('<h1>This document changed</h1><p>It may already be signed or was updated by the owner.</p>', 409);
      try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Signed: ${doc.title}`, body: `${doc.title}\n\n${name} signed this document at ${signedAt}.\nSignature record: ${hash.slice(0, 16)}\n\nSigned PDF:\n${url.href.split('?')[0]}?token=${encodeURIComponent(form.get('token'))}&pdf=1` }))); } catch { /* the signature is stored even when mail fails */ }
      return signedPage({ ...doc, status: 'signed' }, form.get('token'));
    } catch { return json({ error: 'The sign-off could not be completed.' }, 500); }
  };
}
