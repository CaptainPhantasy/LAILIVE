import fs from 'node:fs';
import path from 'node:path';
import { validateTestimonialList, renderReviewsPage } from './lib/testimonials.js';

const root = path.resolve('dist');
const source = path.resolve('catalog/testimonials.json');
const site = 'https://legacyai.space';

let entries = [];
if (fs.existsSync(source)) {
  try { entries = JSON.parse(fs.readFileSync(source, 'utf8')); }
  catch (error) { console.error('catalog/testimonials.json is not valid JSON:', error.message); process.exit(1); }
}
if (!Array.isArray(entries)) { console.error('catalog/testimonials.json must be an array of testimonial objects.'); process.exit(1); }

const checked = validateTestimonialList(entries);
if (!checked.ok) {
  console.error('The customer note page was not built. Fix these before publishing:');
  for (const error of checked.errors) console.error('-', error);
  process.exit(1);
}

const out = path.join(root, 'reviews');
// dist/reviews is wholly generated, so a withdrawn entry cannot linger as a live page.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), renderReviewsPage(entries, { site }));
console.log(entries.length ? `Wrote the customer notes page with ${entries.length} approved note${entries.length === 1 ? '' : 's'}.` : 'No approved customer notes; wrote the empty page.');
