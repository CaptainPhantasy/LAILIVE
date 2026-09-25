import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const read = p => readFileSync(p, 'utf8');
const pages = {
  '/': 'dist/index.html',
  '/solutions/': 'dist/solutions/index.html',
  '/intake/': 'dist/intake/index.html',
  '/board/': 'dist/board/index.html',
  '/deal/': 'dist/deal/index.html',
  '/contact-health/': 'dist/contact-health/index.html',
};
const ld = html => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));

test('every public page has a unique title, description, canonical, social card and parseable structured data', () => {
  const titles = new Set(), descriptions = new Set();
  for (const [route, file] of Object.entries(pages)) {
    const html = read(file);
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    const description = html.match(/<meta name="description" content="([^"]+)"/)?.[1];
    assert(title && description, `${file} needs a title and a description`);
    assert(!titles.has(title) && !descriptions.has(description), `${file} duplicates another public page's title or description`);
    titles.add(title); descriptions.add(description);
    assert(html.includes(`<link rel="canonical" href="https://legacyai.space${route}"`), `${file} needs its canonical URL`);
    assert.match(html, /<meta name="robots" content="index/, `${file} should be indexable`);
    assert(html.includes('property="og:image" content="https://legacyai.space/og-solutions.jpg"'), `${file} needs the social card`);
    assert(html.includes(`property="og:url" content="https://legacyai.space${route}"`), `${file} needs og:url`);
    assert(ld(html).length >= 1, `${file} needs structured data`);
  }
});

test('the owner workspace stays out of search indexes while staying crawlable', () => {
  assert.match(read('dist/owner/index.html'), /<meta name="robots" content="noindex/);
  const vercel = JSON.parse(read('vercel.json'));
  const ownerHeaders = vercel.headers.find(h => h.source === '/owner/(.*)');
  assert(ownerHeaders && ownerHeaders.headers.some(h => h.key === 'X-Robots-Tag' && h.value.includes('noindex')), 'vercel.json must send X-Robots-Tag noindex for /owner/');
  const robots = read('dist/robots.txt');
  assert(!/Disallow: \/owner\//.test(robots), 'robots.txt must not block /owner/, or crawlers can never read its noindex directive');
  assert.match(robots, /Disallow: \/api\//);
  for (const bot of ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'Bingbot', 'Applebot', 'Amazonbot']) assert(robots.includes(`User-agent: ${bot}`), `robots.txt should name ${bot}`);
  assert.match(robots, /Sitemap: https:\/\/legacyai\.space\/sitemap\.xml/);
});

test('the sitemap lists exactly the public pages and nothing else', () => {
  const sitemap = read('dist/sitemap.xml');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.deepEqual(new Set(locs), new Set(Object.keys(pages).map(route => `https://legacyai.space${route}`)));
});

test('the service list in the structured data matches the catalog exactly', () => {
  const catalog = JSON.parse(read('dist/service-catalog.json'));
  const html = read('dist/solutions/index.html');
  const itemList = ld(html).find(b => b['@type'] === 'ItemList');
  assert(itemList, 'the solutions page needs the ItemList structured data (run npm run build:seo)');
  assert.equal(itemList.numberOfItems, catalog.services.length);
  assert.equal(itemList.itemListElement.length, catalog.services.length);
  for (const [i, item] of itemList.itemListElement.entries()) {
    assert.equal(item.item.name, catalog.services[i].name);
    assert.equal(item.item.url, `https://legacyai.space/solutions/#${catalog.services[i].id}`);
  }
});

test('the home page answers owner questions with matching FAQ structured data', () => {
  const html = read('dist/index.html');
  const faq = ld(html).find(b => b['@type'] === 'FAQPage');
  assert(faq, 'the home page needs FAQ structured data');
  assert(faq.mainEntity.length >= 5);
  for (const entry of faq.mainEntity) {
    assert.equal(entry['@type'], 'Question');
    assert(html.includes(entry.name.replace('Legacy AI for', 'it for')), `the FAQ question "${entry.name}" must be visible on the page`);
    assert(entry.acceptedAnswer.text.length > 40);
  }
});

test('the AI-facing files exist and the social card is a real JPEG', () => {
  const llms = read('dist/llms.txt');
  assert.match(llms, /^# Legacy AI/);
  assert(llms.includes('douglas@legacyai.space'));
  const full = read('dist/llms-full.txt');
  const catalog = JSON.parse(read('dist/service-catalog.json'));
  for (const s of catalog.services) assert(full.includes(s.name), `llms-full.txt should list ${s.name}`);
  assert(existsSync('dist/og-solutions.jpg'));
  const jpg = readFileSync('dist/og-solutions.jpg');
  assert.equal(jpg[0], 0xff);
  assert.equal(jpg[1], 0xd8);
});
