import { randomUUID } from 'node:crypto';
import { OWNER_ADDRESSES, frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { signOwnerToken, readOwnerToken } from './owner-documents-core.js';
import { validateTestimonial, testimonialEntryJson, PERMISSIONS } from './testimonials.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'customer';
const page = (html, status = 200) => new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legacy AI customer note</title><style>body{font:18px system-ui;max-width:720px;margin:24px auto;padding:16px}h1{font-size:1.4em}label{display:block;margin:14px 0 4px;font-weight:600}input,select,textarea{box-sizing:border-box;width:100%;font:16px system-ui;padding:8px}textarea{min-height:140px}button{display:block;width:100%;box-sizing:border-box;padding:16px;margin:18px 0 8px;font:18px system-ui;border-radius:8px;border:1px solid #ccc;background:#fff}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f6f6;padding:12px}p{overflow-wrap:anywhere}</style>${html}</html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });

// A customer's words only reach the website after the owner confirms two separate
// things on this page: the wording is exactly what the customer said, and the
// customer allowed it to be public. The page never writes to the repo; it prints the
// one catalog entry the owner commits after reading it.
export function createTestimonialApproval({ mail, env = process.env, now = Date.now } = {}) {
  const secret = () => env.RECEPTIONIST_SESSION_SECRET;
  const origin = () => new URL(env.FRONTDESK_PUBLIC_ORIGIN || 'https://legacyai.space').origin;
  const linkFor = candidate => `${origin()}/api/frontdesk/testimonials?token=${signOwnerToken({ ...candidate, scope: 'testimonial', exp: now() + 14 * 86400000 }, secret())}`;
  const today = () => new Date(now()).toISOString().slice(0, 10);

  const form = (candidate, tokenValue, message = '') => page(`<h1>Publish a customer note?</h1>
${message ? `<p><b>${esc(message)}</b></p>` : ''}
<p>Check that this is exactly what the customer said, then record how you are allowed to show it.</p>
<form method="post"><input type="hidden" name="token" value="${esc(tokenValue)}">
<label for="quote">What the customer said</label><textarea id="quote" name="quote" maxlength="600">${esc(candidate.quote)}</textarea>
<label for="author">Name to show</label><input id="author" name="author" maxlength="80" value="${esc(candidate.author)}">
<label for="context">What the work was (job and town)</label><input id="context" name="context" maxlength="120" value="${esc(candidate.context)}">
<label for="permission">Why you may publish it</label><select id="permission" name="permission">${PERMISSIONS.map(value => `<option value="${value}"${candidate.permission === value ? ' selected' : ''}>${value === 'written' ? 'Written permission from the customer' : value === 'public-review' ? 'It is a public review (link required)' : 'Recorded verbal consent'}</option>`).join('')}</select>
<label for="source">Where it came from (owner-provided, or the https review link)</label><input id="source" name="source" maxlength="500" value="${esc(candidate.source || 'owner-provided')}">
<label for="rating">Rating, if the customer gave one</label><input id="rating" name="rating" inputmode="numeric" maxlength="1" value="${esc(candidate.rating ?? '')}">
<label for="approved_on">Date you approved it</label><input id="approved_on" name="approved_on" type="date" value="${esc(candidate.approved_on || today())}">
<button name="action" value="approve">Approve the wording and permission</button>
<button name="action" value="reject">Do not publish this one</button>
</form>
<p><small>Approving produces a file entry. Nothing is published by this page, and no one can publish without that entry being added to the site.</small></p>`);

  return async request => {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const access = readOwnerToken(url.searchParams.get('token'), secret(), now());
        if (!access || access.scope !== 'testimonial') return page('<h1>This link is not valid</h1>', 401);
        return form(access, url.searchParams.get('token'));
      }
      if (request.method !== 'POST') return json({ error: 'GET or POST required.' }, 405);
      if (Number(request.headers.get('content-length') || 0) > 20000) return json({ error: 'Too large.' }, 413);

      if (request.headers.get('content-type')?.includes('application/json')) {
        if (!env.CONTENT_SECRET && !env.RECEPTIONIST_WEBHOOK_SECRET) return json({ error: 'Not authorized.' }, 401);
        if (!frontdeskSecret(request).some(value => secretMatches(value, env.CONTENT_SECRET || env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 20000) return json({ error: 'Too large.' }, 413);
        const input = JSON.parse(raw);
        const candidate = {
          quote: bounded(input.quote, 600),
          author: bounded(input.author, 80),
          context: bounded(input.context, 120),
          permission: PERMISSIONS.includes(input.permission) ? input.permission : 'written',
          source: bounded(input.source, 500) || 'owner-provided',
          rating: bounded(String(input.rating ?? ''), 1),
        };
        if (candidate.quote.length < 20) return json({ error: 'A quote of at least 20 characters is required.' }, 400);
        if (!candidate.author) return json({ error: 'The name to show is required.' }, 400);
        const approveLink = linkFor(candidate);
        try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Customer note to check: ${candidate.author}`, body: `A customer note is waiting for your approval.\n\n"${candidate.quote}"\n— ${candidate.author}, ${candidate.context}\n\nCheck the wording and record the permission here:\n${approveLink}\n\nNothing is published until you approve it and the entry is added to the site.` }))); }
        catch { return json({ error: 'The approval email could not be sent.' }, 502); }
        return json({ ok: true, status: 'awaiting_owner' });
      }

      const data = await request.formData();
      const access = readOwnerToken(data.get('token'), secret(), now());
      if (!access || access.scope !== 'testimonial') return page('<h1>This link is not valid</h1>', 401);
      if (data.get('action') === 'reject') {
        try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Customer note rejected: ${access.author}`, body: `You chose not to publish this note:\n\n"${access.quote}"\n\nNothing was published.` }))); } catch { /* the decision stands */ }
        return page('<h1>Not published</h1><p>This note stays out of the site. Nothing was changed.</p>');
      }
      if (data.get('action') !== 'approve') return page('<h1>Unknown action</h1>', 400);

      const entry = {
        id: `${slug(data.get('author'))}-${today().slice(0, 7)}-${randomUUID().slice(0, 4)}`,
        quote: bounded(data.get('quote'), 600),
        author: bounded(data.get('author'), 80),
        context: bounded(data.get('context'), 120),
        permission: String(data.get('permission') || ''),
        source: bounded(data.get('source'), 500),
        approved_on: bounded(data.get('approved_on'), 10),
        ...(bounded(String(data.get('rating') ?? ''), 1) ? { rating: Number(data.get('rating')) } : {}),
      };
      const checked = validateTestimonial(entry);
      if (!checked.ok) return form(entry, data.get('token'), `Not ready: ${checked.errors.join(' ')}`);

      const entryJson = testimonialEntryJson(entry);
      try { await Promise.all(OWNER_ADDRESSES.map(to => mail({ to, subject: `Customer note approved: ${entry.author}`, body: `This note is cleared to publish. Add this entry to catalog/testimonials.json and rebuild:\n\n${entryJson}` }))); } catch { /* the entry is still shown below */ }
      return page(`<h1>Approved</h1><p>This is the only thing left to publish it. Add this object to the array in <code>catalog/testimonials.json</code>, then run the build. Nothing is live until that file changes.</p><pre>${esc(entryJson)}</pre><p><small>A copy was emailed to you. The customer's note appears at /reviews/ after the next build.</small></p>`);
    } catch { return json({ error: 'The customer note action could not be completed.' }, 500); }
  };
}
