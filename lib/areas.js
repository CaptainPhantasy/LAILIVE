const placeholders = /^(tbd|todo|n\/a|na|xxx+|placeholder|change me|example)$/i;
const str = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.trim().length <= max ? value.trim() : '';
const httpsUrl = value => { try { return new URL(String(value)).protocol === 'https:'; } catch { return false; } };

// Validates one neighborhood page against facts the owner must supply. Nothing is
// generated from guesswork: a missing fact is an error, not a default.
export function validateArea(area) {
  const errors = [];
  const value = area && typeof area === 'object' ? area : {};
  if (!/^[a-z0-9-]{2,60}$/.test(String(value.slug || ''))) errors.push('slug must be lowercase letters, numbers, or hyphens.');
  for (const [field, label, min, max] of [['town', 'town', 2, 80], ['county', 'county', 2, 80], ['state', 'state', 2, 2], ['service_note', 'service note', 40, 800]]) {
    const content = str(value[field], min, max);
    if (!content || placeholders.test(content)) errors.push(`${label} is required and cannot be a placeholder.`);
  }
  const zips = Array.isArray(value.zips) ? value.zips : [];
  if (!zips.length || zips.some(zip => !/^\d{5}$/.test(String(zip)))) errors.push('At least one 5-digit ZIP code is required.');
  const landmarks = Array.isArray(value.landmarks) ? value.landmarks.map(item => str(item, 2, 120)).filter(Boolean) : [];
  if (!landmarks.length || landmarks.some(item => placeholders.test(item))) errors.push('At least one real local landmark is required.');
  const source = str(value.source, 10, 500);
  if (!source || (!httpsUrl(source) && placeholders.test(source))) errors.push('A source for the local facts is required (an https URL or a dated note).');
  else if (httpsUrl(source)) {
    const host = new URL(source).hostname;
    if (/^(www\.)?example\.(com|org|net)$/i.test(host) || host === 'localhost') errors.push('source must point at a real page, not an example domain.');
  }
  const verified = Date.parse(String(value.verified_on || ''));
  if (!Number.isFinite(verified)) errors.push('verified_on must be a date when you last checked the facts.');
  else if (verified > Date.now() || verified < Date.now() - 365 * 86400000) errors.push('verified_on must be within the last year and not in the future.');
  return { ok: errors.length === 0, errors };
}

export function validateAreaList(areas) {
  if (!Array.isArray(areas)) return { ok: false, errors: ['areas must be an array.'] };
  if (areas.length > 100) return { ok: false, errors: ['At most 100 area pages at a time.'] };
  const errors = [];
  const seen = new Set();
  areas.forEach((area, index) => {
    const checked = validateArea(area);
    for (const error of checked.errors) errors.push(`area ${index + 1}: ${error}`);
    const slug = String(area?.slug || '');
    if (slug && seen.has(slug)) errors.push(`area ${index + 1}: duplicate slug ${slug}.`);
    seen.add(slug);
  });
  return { ok: errors.length === 0, errors };
}

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderAreaPage(area, { site = 'https://legacyai.space' } = {}) {
  const title = `${area.town}, ${area.state} plumbing help — Legacy AI`;
  const description = `Local service for ${area.town} (${area.county} County, ${area.state}). ${area.service_note}`.slice(0, 300);
  const zips = area.zips.join(', ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${site}/areas/${esc(area.slug)}/">
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Service', name: `Legacy AI in ${area.town}, ${area.state}`, areaServed: { '@type': 'City', name: area.town }, provider: { '@type': 'Organization', name: 'Legacy AI' } })}</script>
</head><body><main><h1>Plumbing help in ${esc(area.town)}, ${esc(area.state)}</h1>
<p>${esc(area.service_note)}</p>
<h2>Where we work</h2><p>${esc(area.town)}, ${esc(area.county)} County, ${esc(area.state)} — ZIP codes ${esc(zips)}.</p>
<h2>Local landmarks</h2><ul>${area.landmarks.map(item => `<li>${esc(item)}</li>`).join('')}</ul>
<h2>Facts checked</h2><p>Last verified ${esc(area.verified_on)}. Source: ${httpsUrl(area.source) ? `<a href="${esc(area.source)}" rel="noreferrer noopener">${esc(area.source)}</a>` : esc(area.source)}.</p>
<p><a href="/intake/">Ask for a visit</a> · <a href="/solutions/">See what we do</a></p>
<p><small>This page is built from facts the owner supplied and verified. It is not generated from guesses.</small></p>
</main></body></html>`;
}

export function renderAreaIndex(areas, { site = 'https://legacyai.space' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Areas served — Legacy AI</title><meta name="description" content="Cities and towns Legacy AI serves in Indiana."><link rel="canonical" href="${site}/areas/"></head>
<body><main><h1>Areas served</h1>${areas.length ? `<ul>${areas.map(area => `<li><a href="/areas/${esc(area.slug)}/">${esc(area.town)}, ${esc(area.state)}</a> — ${esc(area.county)} County</li>`).join('')}</ul>` : '<p>No area pages are configured yet.</p>'}
<p><a href="/intake/">Ask for a visit</a></p></main></body></html>`;
}
