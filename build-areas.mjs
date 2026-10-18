import fs from 'node:fs';
import path from 'node:path';
import { validateAreaList, renderAreaPage, renderAreaIndex } from './lib/areas.js';

const root = path.resolve('dist');
const source = path.resolve('catalog/areas.json');
const site = 'https://legacyai.space';

let areas = [];
if (fs.existsSync(source)) {
  try { areas = JSON.parse(fs.readFileSync(source, 'utf8')); }
  catch (error) { console.error('catalog/areas.json is not valid JSON:', error.message); process.exit(1); }
}
if (!Array.isArray(areas)) { console.error('catalog/areas.json must be an array of area objects.'); process.exit(1); }

const checked = validateAreaList(areas);
if (!checked.ok) {
  console.error('Area pages were not built. Fix these facts first:');
  for (const error of checked.errors) console.error('-', error);
  process.exit(1);
}

const out = path.join(root, 'areas');
// dist/areas is wholly generated, so clearing it keeps a removed area from
// lingering as a live page.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), renderAreaIndex(areas, { site }));
for (const area of areas) {
  const dir = path.join(out, area.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), renderAreaPage(area, { site }));
}
console.log(areas.length ? `Wrote ${areas.length} area page${areas.length === 1 ? '' : 's'} and the areas index.` : 'No area pages configured; wrote the empty areas index.');
