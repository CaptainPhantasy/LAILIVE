const SECRET_PATTERNS = [
  { code: 'secret_like_key', pattern: /sk_live_[A-Za-z0-9]{10,}/ },
  { code: 'secret_like_key', pattern: /AKIA[0-9A-Z]{16}/ },
  { code: 'secret_like_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { code: 'secret_like_assignment', pattern: /(?:api[_-]?key|client[_-]?secret|password)\s*[:=]\s*['"][^'"]{12,}['"]/i },
];
const DANGEROUS = [
  { code: 'eval_usage', pattern: /\beval\s*\(/, severity: 'critical' },
  { code: 'document_write', pattern: /document\.write\s*\(/, severity: 'warning' },
  { code: 'source_map_reference', pattern: /sourceMappingURL=/, severity: 'warning' },
];
const INSECURE_URL = /(?:src|href)\s*=\s*["']http:\/\/(?!localhost|127\.0\.0\.1)/i;

// Checks the built assets and live responses for the protections the project
// claims. It measures a short, named list; it is not an eighty-vector scan.
export function scanAssets(files) {
  const findings = [];
  for (const file of files) {
    const content = String(file.content || '');
    for (const { code, pattern } of SECRET_PATTERNS) if (pattern.test(content)) findings.push({ code, severity: 'critical', detail: file.path });
    for (const { code, pattern, severity } of DANGEROUS) if (pattern.test(content)) findings.push({ code, severity, detail: file.path });
    if (INSECURE_URL.test(content)) findings.push({ code: 'insecure_http', severity: 'warning', detail: file.path });
  }
  return findings;
}

export function checkProbe(label, { status, headers = {} } = {}, { expect = [401, 405], requiredHeaders = [] } = {}) {
  const findings = [];
  if (!expect.includes(status)) findings.push({ code: 'unexpected_status', severity: 'critical', detail: `${label} returned ${status}, expected ${expect.join(' or ')}` });
  for (const name of requiredHeaders) {
    const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
    if (!value) findings.push({ code: 'missing_security_header', severity: 'warning', detail: `${label} is missing ${name}` });
  }
  return findings;
}

export function summarize(findings, checks) {
  const critical = findings.filter(item => item.severity === 'critical').length;
  const warning = findings.filter(item => item.severity === 'warning').length;
  return { checks, critical, warning, passed: critical === 0, findings };
}
