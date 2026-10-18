const placeholders = /^(tbd|todo|n\/a|na|xxx+|placeholder|change me|example|test|test customer)$/i;
const str = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.trim().length <= max ? value.trim() : '';
const httpsUrl = value => { try { return new URL(String(value)).protocol === 'https:'; } catch { return false; } };
const PERMISSIONS = ['written', 'public-review', 'recorded-consent'];

// A published testimonial is a claim about a real customer. It is only allowed on
// the site when the owner can name where it came from and why sharing it is allowed.
export function validateTestimonial(entry) {
  const errors = [];
  const value = entry && typeof entry === 'object' ? entry : {};
  if (!/^[a-z0-9-]{2,60}$/.test(String(value.id || ''))) errors.push('id must be lowercase letters, numbers, or hyphens.');
  const quote = str(value.quote, 20, 600);
  if (!quote || placeholders.test(quote)) errors.push('quote is required, 20 to 600 characters, and cannot be a placeholder.');
  const author = str(value.author, 2, 80);
  if (!author || placeholders.test(author)) errors.push('author is required and cannot be a placeholder.');
  if (!str(value.context, 2, 120)) errors.push('context is required (the work and the town, for example).');
  const permission = String(value.permission || '');
  if (!PERMISSIONS.includes(permission)) errors.push('permission must be written, public-review, or recorded-consent.');
  const source = str(value.source, 2, 500);
  if (permission === 'public-review') {
    if (!httpsUrl(source)) errors.push('a public review needs the https link to the review itself.');
    else {
      const host = new URL(source).hostname;
      if (/^(www\.)?example\.(com|org|net)$/i.test(host) || host === 'localhost') errors.push('source must point at the real review, not an example domain.');
    }
  } else if (!source || (!httpsUrl(source) && !/^owner-provided$/i.test(source))) {
    errors.push('source must be owner-provided or an https link to where it was sent.');
  }
  const approved = Date.parse(String(value.approved_on || ''));
  if (!Number.isFinite(approved)) errors.push('approved_on must be the date the owner approved publishing it.');
  else if (approved > Date.now()) errors.push('approved_on cannot be in the future.');
  else if (approved < Date.now() - 3 * 365 * 86400000) errors.push('approved_on is older than three years; confirm the customer still agrees.');
  if (value.rating !== undefined && value.rating !== null && value.rating !== '') {
    const rating = Number(value.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) errors.push('rating, when present, must be a whole number from 1 to 5.');
  }
  return { ok: errors.length === 0, errors };
}

export function validateTestimonialList(entries) {
  if (!Array.isArray(entries)) return { ok: false, errors: ['testimonials must be an array.'] };
  if (entries.length > 50) return { ok: false, errors: ['At most 50 published testimonials at a time.'] };
  const errors = [];
  const seen = new Set();
  entries.forEach((entry, index) => {
    for (const error of validateTestimonial(entry).errors) errors.push(`testimonial ${index + 1}: ${error}`);
    const id = String(entry?.id || '');
    if (id && seen.has(id)) errors.push(`testimonial ${index + 1}: duplicate id ${id}.`);
    seen.add(id);
  });
  return { ok: errors.length === 0, errors };
}

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const sourceLine = entry => {
  if (entry.permission === 'public-review') return `Public review: <a href="${esc(entry.source)}" rel="noreferrer noopener">read the original</a>`;
  if (entry.permission === 'recorded-consent') return `Shared with recorded consent on ${esc(entry.approved_on)}`;
  return 'Shared with written permission';
};

export function renderReviewsPage(entries, { site = 'https://legacyai.space' } = {}) {
  const count = entries.length;
  const title = 'Customer notes — Legacy AI';
  const description = 'Notes from customers of Legacy AI, published only with their permission.';
  const robots = count ? 'index,follow' : 'noindex,follow';
  const structured = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Customer notes about Legacy AI',
    itemListElement: entries.map((entry, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      item: {
        '@type': 'Quotation',
        text: entry.quote,
        spokenByCharacter: entry.author,
        ...(entry.rating ? { reviewRating: { '@type': 'Rating', ratingValue: entry.rating, bestRating: 5 } } : {}),
      },
    })),
  };
  const body = count
    ? entries.map(entry => `<figure>
<p><b>${entry.context}</b>${entry.rating ? ` · ${entry.rating}/5` : ''}</p>
<blockquote><p>${esc(entry.quote)}</p></blockquote>
<figcaption>— ${esc(entry.author)}<br><small>${sourceLine(entry)}</small></figcaption>
</figure>`).join('\n')
    : '<p>No customer notes are published yet. Notes appear here only after a customer gives permission and the owner approves the wording.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><meta name="robots" content="${robots}"><link rel="canonical" href="${site}/reviews/">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:type" content="website"><meta property="og:url" content="${site}/reviews/"><meta property="og:image" content="${site}/og-solutions.jpg">
${count ? `<script type="application/ld+json">${JSON.stringify(structured).replace(/</g, '\\u003c')}</script>` : ''}
</head><body><main><h1>Customer notes</h1>
<p>Every note below is a real customer's words, shown only where that customer allowed it. No note is written, edited into a claim, or invented by Legacy AI.</p>
${body}
<h2>Work with us</h2><p><a href="/intake/">Ask for a visit</a> · <a href="/solutions/">See what we do</a></p>
<p><small>Something here look wrong? Reply to any Legacy AI email and it comes out the same day.</small></p>
</main></body></html>`;
}

// Turns an approved entry into the exact text that belongs in catalog/testimonials.json.
export function testimonialEntryJson(entry) {
  const clean = {
    id: entry.id,
    quote: entry.quote,
    author: entry.author,
    context: entry.context,
    permission: entry.permission,
    source: entry.source,
    approved_on: entry.approved_on,
  };
  if (entry.rating) clean.rating = Number(entry.rating);
  return JSON.stringify(clean, null, 2);
}

export { PERMISSIONS };
