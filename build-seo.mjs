import fs from 'node:fs';
import path from 'node:path';

// Single source for crawler and AI-facing files: dist/service-catalog.json + this page list.
const root = path.resolve('dist');
const site = 'https://legacyai.space';
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'service-catalog.json'), 'utf8'));
const pages = [
  { url: '/', priority: '1.0' },
  { url: '/solutions/', priority: '0.9' },
  { url: '/intake/', priority: '0.9' },
  { url: '/contact-health/', priority: '0.8' },
  { url: '/deal/', priority: '0.8' },
  { url: '/board/', priority: '0.7' },
];
const summary = 'Legacy AI builds and runs pre-built AI systems for owner-operated businesses across Indiana — phone answering, lead follow-up, scheduling, reviews, reporting and customer records. 54 productized solutions, already in production. One call. One person. One bill.';

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(p => `  <url>\n    <loc>${site}${p.url}</loc>\n    <priority>${p.priority}</priority>\n  </url>`).join('\n')}
</urlset>
`;
fs.writeFileSync(path.join(root, 'sitemap.xml'), sitemap);

const llms = `# Legacy AI

> ${summary}

Legacy AI is led by founder Douglas Talley and based in Brown County, Indiana. Everything offered is already built and already in production for businesses such as an auto body shop in Bloomington, a plumber's office in Nashville, a chiropractor in Columbus, and a property inspection company covering every county in Indiana. The model is a menu: read the solutions, pick what hurts, and agree on scope, price and timeline in writing before work begins. Service trades, advertising exchanges and combined arrangements are welcome.

## Pages
- [Thesis — what Legacy AI is](${site}/): The promise, the proof points and the working philosophy.
- [All 54 solutions](${site}/solutions/): The full menu in five pillars — Fill The Calendar, Run The Business, Look Bigger Than You Are, Be Everywhere Without Working More, Sleep At Night.
- [Intake](${site}/intake/): Pick your pain points and see which solutions fix them.
- [The Deal](${site}/deal/): Five steps from a 30-minute call to launch and ongoing improvement, plus the six industries already served.
- [The Board](${site}/board/): Five AI advisor perspectives examine one business decision — recommendation, dissent, risks, next steps.
- [Contact-list health check](${site}/contact-health/): A browser tool that reviews a customer CSV for missing details, duplicate rows and conflicting contact information.

## Contact
- Email: douglas@legacyai.space
- Site: ${site}
- Field guide (PDF): ${site}/catalog.pdf

## Optional
- [Full content for AI systems](${site}/llms-full.txt): Every solution with its description, the industries served and the five working steps.
`;
fs.writeFileSync(path.join(root, 'llms.txt'), llms);

const llmsFull = `# Legacy AI — full content

> ${summary}

Legacy AI is led by founder Douglas Talley and based in Brown County, Indiana. Everything offered is already built and already in production for businesses such as an auto body shop in Bloomington, a plumber's office in Nashville, a chiropractor in Columbus, and a property inspection company covering every county in Indiana.

## How engagements work
1. You tell us what's broken — describe the pain points on a 30-minute call. No pitch.
2. We agree on the plan — scope, price and timeline in writing before work begins. Most projects begin with a deposit; for service trades, advertising exchanges or combined arrangements, the value and commitments are agreed up front.
3. We build. You see it working — configuration, customization and testing, then a walkthrough with your branding and workflow. One session.
4. We go live together — launch and put it to work. Payments follow the agreed schedule, with milestones for larger projects. Day one.
5. We keep making it better — monthly reports, quarterly reviews, ongoing improvements.

## Industries already served
Auto body & collision; plumbers, HVAC and contractors; chiropractic & wellness; restaurants & hospitality; professional services; property inspection. If your business has customers, Legacy AI can build for it.

## The 54 solutions
${catalog.services.map(s => `- ${s.name} (${s.tag}): ${s.body}`).join('\n')}

## Pages
- Thesis: ${site}/
- All solutions: ${site}/solutions/
- Intake: ${site}/intake/
- The Deal: ${site}/deal/
- The Board: ${site}/board/
- Contact-list health check: ${site}/contact-health/

## Contact
- Email: douglas@legacyai.space
- Site: ${site}
- Field guide (PDF): ${site}/catalog.pdf
`;
fs.writeFileSync(path.join(root, 'llms-full.txt'), llmsFull);

const servicesList = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: 'Legacy AI — 54 productized AI solutions',
  numberOfItems: catalog.services.length,
  itemListElement: catalog.services.map((s, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    item: {
      '@type': 'Service',
      name: s.name,
      description: s.body,
      serviceType: s.tag,
      url: `${site}/solutions/#${s.id}`,
      provider: { '@type': 'Organization', name: 'Legacy AI', url: site },
    },
  })),
};
const file = path.join(root, 'solutions', 'index.html');
const html = fs.readFileSync(file, 'utf8');
const start = '<!--seo:services-jsonld-->', end = '<!--/seo:services-jsonld-->';
const a = html.indexOf(start), b = html.indexOf(end);
if (a < 0 || b < 0) throw new Error('seo:services-jsonld markers are missing in dist/solutions/index.html');
const block = `${start}\n<script type="application/ld+json">${JSON.stringify(servicesList)}</script>\n${end}`;
fs.writeFileSync(file, html.slice(0, a) + block + html.slice(b + end.length));
console.log('Wrote sitemap.xml, llms.txt, llms-full.txt and', catalog.services.length, 'service entries into /solutions/.');
