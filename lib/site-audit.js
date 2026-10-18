import { connect } from 'node:tls';

const SECURITY_HEADERS = ['strict-transport-security', 'content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy'];

async function defaultTlsDays(host) {
  return await new Promise((resolve, reject) => {
    const socket = connect({ host, port: 443, servername: host, timeout: 8000 }, () => {
      try {
        const certificate = socket.getPeerCertificate();
        const expires = Date.parse(certificate.valid_to);
        socket.end();
        resolve(Number.isFinite(expires) ? Math.floor((expires - Date.now()) / 86400000) : null);
      } catch (error) { socket.destroy(); reject(error); }
    });
    socket.on('error', reject);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('TLS timeout')); });
  });
}

const text = (html, pattern) => {
  const match = html.match(pattern);
  return match ? match[1].replace(/\s+/g, ' ').trim().slice(0, 300) : '';
};

// Measures a live page and returns findings. It changes nothing and reports only
// what the response actually contained.
export async function auditSite(input, { fetcher = fetch, tlsDays = defaultTlsDays } = {}) {
  const started = Date.now();
  const response = await fetcher(input, { redirect: 'follow', signal: AbortSignal.timeout(12000) });
  const html = await response.text();
  const ms = Date.now() - started;
  const finalUrl = response.url || input;
  const origin = new URL(finalUrl).origin;
  const issues = [];
  const add = (code, severity, detail) => issues.push({ code, severity, detail });

  if (!/^https:\/\//i.test(finalUrl)) add('not_https', 'critical', `Final URL is ${finalUrl}`);
  if (!response.ok) add('http_status', 'critical', `HTTP ${response.status}`);

  const title = text(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = text(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i);
  const canonical = /<link[^>]+rel=["']canonical["']/i.test(html);
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const h1 = (html.match(/<h1[\s>]/gi) || []).length;
  if (!title) add('missing_title', 'critical', 'No <title>');
  else if (title.length < 10) add('short_title', 'warning', `Title is ${title.length} characters`);
  if (!description) add('missing_description', 'warning', 'No meta description');
  if (!viewport) add('missing_viewport', 'critical', 'No viewport meta tag');
  if (!canonical) add('missing_canonical', 'warning', 'No canonical link');
  if (h1 !== 1) add('heading_structure', 'warning', `${h1} H1 elements`);

  const images = html.match(/<img\b[^>]*>/gi) || [];
  const missingAlt = images.filter(tag => !/\balt\s*=\s*["'][^"']*["']/i.test(tag)).length;
  if (missingAlt) add('images_missing_alt', 'warning', `${missingAlt} of ${images.length} images lack alt text`);

  const present = SECURITY_HEADERS.filter(name => response.headers.get(name));
  const missingHeaders = SECURITY_HEADERS.filter(name => !response.headers.get(name));
  if (missingHeaders.length) add('security_headers', 'warning', `Missing: ${missingHeaders.join(', ')}`);

  let robots = false, sitemap = false;
  try { robots = (await fetcher(`${origin}/robots.txt`, { redirect: 'follow', signal: AbortSignal.timeout(8000) })).ok; } catch { /* reported below */ }
  try { sitemap = (await fetcher(`${origin}/sitemap.xml`, { redirect: 'follow', signal: AbortSignal.timeout(8000) })).ok; } catch { /* reported below */ }
  if (!robots) add('missing_robots', 'warning', 'robots.txt did not return a successful response');
  if (!sitemap) add('missing_sitemap', 'warning', 'sitemap.xml did not return a successful response');

  let tls = null;
  try { tls = await tlsDays(new URL(finalUrl).hostname); } catch { tls = null; }
  if (typeof tls === 'number' && tls <= 14) add('tls_expiring', 'critical', `${tls} days remaining`);

  const links = [...new Set((html.match(/href=["']([^"'#]+)["']/gi) || []).map(value => value.replace(/^href=["']|["']$/gi, '')))]
    .filter(href => href.startsWith('/') || href.startsWith(origin))
    .slice(0, 10);
  const broken = [];
  for (const href of links) {
    const target = href.startsWith('http') ? href : `${origin}${href}`;
    try { const check = await fetcher(target, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) }); if (!check.ok) broken.push(`${target} (${check.status})`); }
    catch { broken.push(`${target} (unreachable)`); }
  }
  if (broken.length) add('broken_links', 'warning', broken.join(', '));

  return {
    url: input, finalUrl, status: response.status, ok: response.ok, ms,
    title, description, h1, viewport, canonical,
    images: images.length, imagesMissingAlt: missingAlt,
    securityHeaders: { present, missing: missingHeaders },
    robots, sitemap, tlsDays: tls,
    linksChecked: links.length, brokenLinks: broken,
    issues,
    measured_at: new Date().toISOString(),
  };
}
