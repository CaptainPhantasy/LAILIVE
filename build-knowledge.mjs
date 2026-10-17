import fs from 'node:fs';
import path from 'node:path';

// Plain-text copy of every public page for the site assistant's knowledge base.
// Regenerate with `npm run build` after page edits, then refresh the ElevenLabs document.
const root = path.resolve('dist');
const pages = [
  ['Home', '/'], ['Solutions', '/solutions/'], ['Intake', '/intake/'], ['The Deal', '/deal/'], ['The Board', '/board/'],
  ['Darla, the Legacy AI receptionist', '/receptionist/'], ['Booking calendar preview', '/booking/'], ['Missed-call text-back builder', '/missed-call/'], ['Contact-list health check', '/contact-health/'],
];
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', rarr: '→', larr: '←', mdash: '—', ndash: '–', middot: '·', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : entities[e] ?? m);
export function pageText(html) {
  let s = html.replace(/<(script|style|header|footer|noscript)[\s\S]*?<\/\1>/gi, '');
  s = s.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? s;
  s = s.replace(/<h([1-6])[^>]*>/gi, '\n\n## ').replace(/<\/(p|li|h[1-6]|div|article|section|dt|dd)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  return decode(s.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').replace(/## \n+/g, '## ').trim();
}
const out = ['# Legacy AI website knowledge', 'Generated from the public pages of legacyai.space. Founder: Douglas Talley, Brown County, Indiana. Phone 812-412-3454. Email douglas@legacyai.space.', ''];
for (const [title, url] of pages) out.push(`# PAGE: ${title} (https://legacyai.space${url})`, '', pageText(fs.readFileSync(path.join(root, url, 'index.html'), 'utf8')), '');
out.push('# FULL SERVICE CATALOG AND HOW ENGAGEMENTS WORK', '', fs.readFileSync(path.join(root, 'llms-full.txt'), 'utf8'));
fs.writeFileSync(path.join(root, 'site-knowledge.txt'), out.join('\n'));
console.log(`Wrote site-knowledge.txt (${pages.length} pages).`);
