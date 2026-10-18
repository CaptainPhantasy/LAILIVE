import fs from 'node:fs';
import path from 'node:path';
import { scanAssets, checkProbe, summarize } from '../lib/security-baseline.js';

const base = process.argv[2] || 'https://legacyai.space';

function walk(dir, files = []) {
  if (files.length > 300) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (files.length > 300) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(html|js|css)$/.test(entry.name) && fs.statSync(full).size < 1000000) files.push({ path: full.replace(process.cwd() + '/', ''), content: fs.readFileSync(full, 'utf8') });
  }
  return files;
}

const findings = [];
const assets = walk(path.join(process.cwd(), 'dist'));
findings.push(...scanAssets(assets));

const probes = [
  '/api/frontdesk/review?token=bad',
  '/api/frontdesk/document?token=bad',
  '/api/frontdesk/signoff?token=bad',
  '/api/frontdesk/invoices?token=bad',
  '/api/frontdesk/quote-photo?token=bad',
  '/api/frontdesk/jobs?token=bad',
  '/api/frontdesk/prospects?token=bad',
  '/api/owner/review-ladder',
  '/api/owner/monitor',
  '/api/owner/invoice-chase',
];
let checks = 0;
for (const probe of probes) {
  try {
    const response = await fetch(`${base}${probe}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    findings.push(...checkProbe(probe, response, { expect: [401, 405] }));
  } catch (error) {
    findings.push({ code: 'probe_unreachable', severity: 'critical', detail: `${probe}: ${error?.message || 'request failed'}` });
  }
  checks++;
}

try {
  const page = await fetch(`${base}/contact-health/`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  findings.push(...checkProbe('/contact-health/', page, { expect: [200], requiredHeaders: ['content-security-policy', 'x-content-type-options'] }));
} catch (error) {
  findings.push({ code: 'probe_unreachable', severity: 'critical', detail: `/contact-health/: ${error?.message || 'request failed'}` });
}
checks++;

const report = summarize(findings, checks);
console.log(JSON.stringify({ base, assets: assets.length, ...report }, null, 2));
console.log(`\n${checks} checks · ${report.critical} critical · ${report.warning} warnings across ${assets.length} built files`);
process.exitCode = report.passed ? 0 : 1;
