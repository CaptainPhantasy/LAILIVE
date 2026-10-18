import test from 'node:test';
import assert from 'node:assert/strict';
import { scanAssets, checkProbe, summarize } from '../lib/security-baseline.js';

test('clean built assets produce no findings', () => {
  const findings = scanAssets([
    { path: 'dist/index.html', content: '<html><script src="/app.js"></script><a href="/x">x</a></html>' },
    { path: 'dist/app.js', content: 'const esc = value => String(value).replace(/</g, "&lt;");' },
  ]);
  assert.deepEqual(findings, []);
});

test('secret-like strings, eval and insecure URLs are each reported', () => {
  const fakeKey = 'sk' + '_live_' + '1234567890abcdef';
  const findings = scanAssets([
    { path: 'dist/leak.js', content: `const key = "${fakeKey}";` },
    { path: 'dist/eval.js', content: 'eval(userInput)' },
    { path: 'dist/http.html', content: '<script src="http://cdn.example.com/a.js"></script>' },
    { path: 'dist/map.js', content: '//# sourceMappingURL=app.js.map' },
  ]);
  const codes = findings.map(item => item.code);
  assert.ok(codes.includes('secret_like_key'));
  assert.ok(codes.includes('eval_usage'));
  assert.ok(codes.includes('insecure_http'));
  assert.ok(codes.includes('source_map_reference'));
  assert.equal(findings.find(item => item.code === 'eval_usage').severity, 'critical');
  assert.equal(findings.find(item => item.code === 'insecure_http').severity, 'warning');
});

test('probe checks flag a wrong status and a missing header, and summarize gates on criticals', () => {
  const wrong = checkProbe('/api/secret', { status: 200, headers: new Headers() }, { expect: [401], requiredHeaders: ['x-content-type-options'] });
  assert.equal(wrong.some(item => item.code === 'unexpected_status' && item.severity === 'critical'), true);
  assert.equal(wrong.some(item => item.code === 'missing_security_header'), true);
  const good = checkProbe('/api/secret', { status: 401, headers: new Headers({ 'x-content-type-options': 'nosniff' }) }, { expect: [401], requiredHeaders: ['x-content-type-options'] });
  assert.deepEqual(good, []);
  assert.equal(summarize(wrong, 1).passed, false);
  assert.equal(summarize(good, 1).passed, true);
});
