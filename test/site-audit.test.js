import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSite } from '../lib/site-audit.js';

const goodHtml = `<!doctype html><html lang="en"><head><title>A complete page title for testing</title>
<meta name="description" content="A useful description of the page.">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="canonical" href="https://example.com/"></head>
<body><h1>Hello</h1><img src="/a.png" alt="A photo"><a href="/about">About</a></body></html>`;
const badHtml = `<!doctype html><html><head></head><body><h2>No heading one</h2><img src="/b.png"><a href="/missing">Missing</a></body></html>`;
const headers = {
  'strict-transport-security': 'max-age=31536000',
  'content-security-policy': "default-src 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

function fetcherFor({ html = goodHtml, status = 200, head = 200, extras = true, responseHeaders = headers } = {}) {
  return async (input, init) => {
    const target = String(input);
    if (target.endsWith('/robots.txt')) return new Response('User-agent: *', { status: extras ? 200 : 404 });
    if (target.endsWith('/sitemap.xml')) return new Response('<urlset></urlset>', { status: extras ? 200 : 404 });
    if (init?.method === 'HEAD') return new Response(null, { status: head });
    return new Response(html, { status, headers: responseHeaders });
  };
}

test('a complete page reports no issues', async () => {
  const report = await auditSite('https://example.com/', { fetcher: fetcherFor(), tlsDays: async () => 60 });
  assert.equal(report.ok, true);
  assert.equal(report.title, 'A complete page title for testing');
  assert.equal(report.h1, 1);
  assert.equal(report.imagesMissingAlt, 0);
  assert.equal(report.robots, true);
  assert.equal(report.sitemap, true);
  assert.equal(report.brokenLinks.length, 0);
  assert.deepEqual(report.issues, []);
});

test('a weak page reports each measured problem', async () => {
  const report = await auditSite('http://example.com/', {
    fetcher: fetcherFor({ html: badHtml, head: 404, extras: false, responseHeaders: {} }),
    tlsDays: async () => 5,
  });
  const codes = report.issues.map(issue => issue.code);
  for (const code of ['not_https', 'missing_title', 'missing_description', 'missing_viewport', 'missing_canonical', 'heading_structure', 'images_missing_alt', 'security_headers', 'missing_robots', 'missing_sitemap', 'tls_expiring', 'broken_links']) {
    assert.ok(codes.includes(code), `expected ${code} in ${codes.join(',')}`);
  }
  assert.equal(report.issues.find(issue => issue.code === 'images_missing_alt').severity, 'warning');
  assert.equal(report.issues.find(issue => issue.code === 'not_https').severity, 'critical');
  assert.ok(report.brokenLinks[0].includes('/missing'));
});

test('a failed page is still reported with its status', async () => {
  const report = await auditSite('https://example.com/', { fetcher: fetcherFor({ status: 500 }), tlsDays: async () => 60 });
  assert.equal(report.ok, false);
  assert.equal(report.status, 500);
  assert.ok(report.issues.some(issue => issue.code === 'http_status' && issue.severity === 'critical'));
});
