import test from 'node:test';
import assert from 'node:assert/strict';
import { smsSegments, gsmSafe, checkMessage, buildTextBacks, render } from '../dist/missed-call/core.js';

test('GSM-7 counts 160/153 per segment and extension characters as two', () => {
  assert.deepEqual(smsSegments('a'.repeat(160)), { encoding: 'GSM-7', units: 160, segments: 1, perSegment: 160 });
  assert.equal(smsSegments('a'.repeat(161)).segments, 2);
  assert.equal(smsSegments('a'.repeat(306)).segments, 2);
  assert.equal(smsSegments('a'.repeat(307)).segments, 3);
  assert.equal(smsSegments('€'.repeat(80)).units, 160);
  assert.equal(smsSegments('').segments, 0);
});

test('any non-GSM character switches to UCS-2 at 70/67 per segment', () => {
  const curly = smsSegments('We’re open');
  assert.equal(curly.encoding, 'UCS-2');
  assert.equal(smsSegments('í'.repeat(70)).segments, 1);
  assert.equal(smsSegments('í'.repeat(71)).segments, 2);
  assert.equal(smsSegments('😀'.repeat(35)).units, 70);
  assert.equal(smsSegments(gsmSafe('We’re “open” – now…')).encoding, 'GSM-7');
});

test('checks flag missing identification, opt-out, shorteners, length and fixable encoding', () => {
  const codes = (text, options) => checkMessage(text, options).map(w => w.code);
  assert.deepEqual(codes('Hi, this is Acme Plumbing. Reply STOP to opt out.', { business: 'Acme Plumbing', first: true }), []);
  assert(codes('Hi there!', { business: 'Acme', first: true }).includes('identify'));
  assert(codes('Acme here', { business: 'Acme', first: true }).includes('opt_out'));
  assert(!codes('Acme here', { business: 'Acme', first: false }).includes('opt_out'));
  assert(!codes('Acme aquí. Responda STOP para cancelar.', { business: 'Acme', first: true, spanish: true }).includes('opt_out'));
  assert(codes('Acme: book at bit.ly/abc STOP', { business: 'Acme' }).includes('shortener'));
  assert(!codes('Acme: book at acmebit.ly.example.com STOP', { business: 'Acme' }).includes('shortener'));
  assert(codes('Acme ' + 'x'.repeat(400), { business: 'Acme' }).includes('length'));
  assert(codes('Acme: we’re here', { business: 'Acme' }).includes('encoding'));
  assert(!codes('Acme ' + 'í'.repeat(190), { business: 'Acme' }).includes('length'));
  assert(codes('Acme ' + 'í'.repeat(210), { business: 'Acme' }).includes('length'));
  assert(codes('ACME PLUMBING CALL US BACK RIGHT NOW', { business: 'Acme' }).includes('caps'));
});

test('starting messages name the business, carry opt-out, stay short and skip empty fields', () => {
  const messages = buildTextBacks({ business: 'Acme Plumbing', link: 'acme.example/book', spanish: true });
  assert.equal(messages.length, 5);
  for (const m of messages) {
    assert(m.text.includes('Acme Plumbing'));
    assert.deepEqual(checkMessage(m.text, { business: 'Acme Plumbing', first: m.first, spanish: m.spanish }), []);
    assert(smsSegments(m.text).segments <= (m.spanish ? 3 : 2), m.key);
    assert(!m.text.includes('{'), 'placeholders are filled');
  }
  const plain = buildTextBacks({ business: 'Acme' });
  assert(!plain.some(m => /book online|hours:/i.test(m.text)));
  assert(plain.filter(m => m.first).every(m => smsSegments(m.text).encoding === 'GSM-7'));
  assert.throws(() => buildTextBacks({ business: '' }), /business name/);
  assert.throws(() => buildTextBacks({ business: 'Acme', link: 'javascript:alert(1)' }), /web address/);
  assert.equal(render('Hi {business} .', { business: 'Acme' }), 'Hi Acme.');
});
