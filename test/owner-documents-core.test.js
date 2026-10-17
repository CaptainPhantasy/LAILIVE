import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { documentPdf, signOwnerToken, readOwnerToken, verifyOwnerPin } from '../lib/owner-documents-core.js';
test('signed scopes expire and reject changes', () => {
  const secret = 'test-session-secret-long-enough';
  const token = signOwnerToken({ scope: 'review', id: 'abc', exp: 100 }, secret);
  assert.equal(readOwnerToken(token, secret, 99).scope, 'review');
  assert.equal(readOwnerToken(token, secret, 100), null);
  assert.equal(readOwnerToken(token + 'x', secret, 99), null);
  assert.equal(readOwnerToken(token, 'wrong', 99), null);
});
test('owner PIN fails closed and compares salted scrypt hash', () => {
  const salt = '0123456789abcdef0123456789abcdef';
  const hash = `${salt}:${scryptSync('123456', salt, 32).toString('hex')}`;
  assert.equal(verifyOwnerPin('123456', hash), true);
  assert.equal(verifyOwnerPin('999999', hash), false);
  assert.equal(verifyOwnerPin('123456', ''), false);
  assert.equal(verifyOwnerPin('12345', hash), false);
});
test('PDF pagination has valid offsets and does not silently corrupt unsupported text', () => {
  const pdf = documentPdf('Field report', Array.from({ length: 100 }, (_, i) => `Line ${i}`).join('\n'));
  assert.ok(pdf.toString('latin1').startsWith('%PDF-1.4'));
  assert.match(pdf.toString('latin1'), /\/Count 3/);
  const source = pdf.toString('latin1');
  const start = Number(source.match(/startxref\n(\d+)/)[1]);
  assert.equal(source.slice(start, start + 4), 'xref');
  assert.throws(() => documentPdf('Test', 'unsupported 🐶'), /unsupported/);
});
