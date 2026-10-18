import { auditSite } from '../lib/site-audit.js';

const url = process.argv[2];
if (!url) { console.error('usage: node scripts/site-audit.mjs <https-url>'); process.exit(64); }

const report = await auditSite(url);
console.log(JSON.stringify(report, null, 2));
const critical = report.issues.filter(issue => issue.severity === 'critical');
console.log(`\n${report.status} in ${report.ms}ms · ${report.issues.length} issue${report.issues.length === 1 ? '' : 's'} (${critical.length} critical)`);
process.exitCode = critical.length ? 1 : 0;
