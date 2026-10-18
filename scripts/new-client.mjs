import fs from 'node:fs';
import { validateTenant } from '../lib/tenant-config.js';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/new-client.mjs <client.json>'); process.exit(64); }
let input;
try { input = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (error) { console.error('Could not read JSON:', error.message); process.exit(2); }

const result = validateTenant(input);
if (result.ok) {
  console.log(JSON.stringify({ ok: true, slug: input.slug, message: 'Valid. Post this file with action save to store the client.' }, null, 1));
  process.exit(0);
}
console.log(JSON.stringify({ ok: false, errors: result.errors }, null, 1));
process.exit(1);
