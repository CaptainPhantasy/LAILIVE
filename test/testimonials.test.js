import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTestimonial, validateTestimonialList, renderReviewsPage, testimonialEntryJson } from '../lib/testimonials.js';
import { createTestimonialApproval } from '../lib/testimonial-review.js';
import { signOwnerToken } from '../lib/owner-documents-core.js';

const today = new Date().toISOString().slice(0, 10);
const entry = {
  id: 'dana-noblesville-2026-10',
  quote: 'Darla caught a call I would have missed and the water heater was booked before I got out of the crawlspace.',
  author: 'Dana R.',
  context: 'Water heater replacement, Noblesville',
  permission: 'written',
  source: 'owner-provided',
  approved_on: today,
  rating: 5,
};

test('a customer note needs real words, a named source of permission, and a dated approval', () => {
  assert.equal(validateTestimonial(entry).ok, true);
  assert.equal(validateTestimonial({ ...entry, quote: 'short' }).ok, false);
  assert.equal(validateTestimonial({ ...entry, quote: 'TBD' }).ok, false);
  assert.equal(validateTestimonial({ ...entry, author: 'Test' }).ok, false);
  assert.equal(validateTestimonial({ ...entry, context: '' }).ok, false);
  assert.equal(validateTestimonial({ ...entry, permission: 'because I said so' }).ok, false);
  assert.equal(validateTestimonial({ ...entry, approved_on: '2999-01-01' }).ok, false);
  assert.equal(validateTestimonial({ ...entry, approved_on: '2019-01-01' }).ok, false);
  assert.equal(validateTestimonial({ ...entry, rating: 9 }).ok, false);
  assert.equal(validateTestimonial({ ...entry, id: 'Bad Id' }).ok, false);
});

test('a public review must link the real review, and written permission cannot hide behind one', () => {
  const publicReview = { ...entry, permission: 'public-review', source: 'https://g.page/r/example/review' };
  assert.equal(validateTestimonial(publicReview).ok, true);
  assert.equal(validateTestimonial({ ...publicReview, source: 'owner-provided' }).ok, false);
  assert.equal(validateTestimonial({ ...publicReview, source: 'http://g.page/r/x' }).ok, false);
  assert.equal(validateTestimonial({ ...publicReview, source: 'https://example.com/review' }).ok, false);
  assert.equal(validateTestimonial({ ...entry, source: '' }).ok, false);
});

test('a list rejects duplicates and the rendered page carries the quote, its source, and a noindex empty state', () => {
  assert.equal(validateTestimonialList([entry]).ok, true);
  assert.equal(validateTestimonialList([entry, entry]).ok, false);
  assert.match(validateTestimonialList([entry, entry]).errors.join(' '), /duplicate id/);
  assert.equal(validateTestimonialList('nope').ok, false);

  const html = renderReviewsPage([{ ...entry, quote: 'They quoted <script>alert(1)</script> fast and showed up on time.' }]);
  assert.match(html, /They quoted &lt;script&gt;alert\(1\)&lt;\/script&gt; fast/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /Shared with written permission/);
  assert.match(html, /Dana R\./);
  assert.match(html, /5\/5/);
  assert.match(html, /"@type":"Quotation"/);
  assert.match(html, /content="index,follow"/);

  const publicHtml = renderReviewsPage([{ ...entry, permission: 'public-review', source: 'https://g.page/r/example/review' }]);
  assert.match(publicHtml, /href="https:\/\/g\.page\/r\/example\/review"/);

  const empty = renderReviewsPage([]);
  assert.match(empty, /content="noindex,follow"/);
  assert.match(empty, /No customer notes are published yet/);
});

test('the approval page refuses a note until the owner records permission, then prints one catalog entry', async () => {
  const sent = [];
  const env = { RECEPTIONIST_SESSION_SECRET: 'a'.repeat(32), CONTENT_SECRET: 'c'.repeat(24), FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space' };
  const handler = createTestimonialApproval({ mail: async message => { sent.push(message); return true; }, env });

  const anonymous = await handler(new Request('https://legacyai.space/api/frontdesk/testimonials', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quote: entry.quote, author: entry.author, context: entry.context }) }));
  assert.equal(anonymous.status, 401);

  const captured = await handler(new Request('https://legacyai.space/api/frontdesk/testimonials', { method: 'POST', headers: { 'content-type': 'application/json', 'x-frontdesk-secret': env.CONTENT_SECRET }, body: JSON.stringify({ quote: entry.quote, author: entry.author, context: entry.context }) }));
  assert.equal(captured.status, 200);
  assert.deepEqual(await captured.json(), { ok: true, status: 'awaiting_owner' });
  assert.equal(sent.length, 2);
  assert.match(sent[0].body, /record the permission here:\nhttps:\/\/legacyai\.space\/api\/frontdesk\/testimonials\?token=/);

  const token = signOwnerToken({ quote: entry.quote, author: entry.author, context: entry.context, permission: 'owner-provided', source: 'owner-provided', scope: 'testimonial', exp: Date.now() + 60000 }, env.RECEPTIONIST_SESSION_SECRET);
  const reviewPage = await handler(new Request(`https://legacyai.space/api/frontdesk/testimonials?token=${token}`));
  assert.equal(reviewPage.status, 200);
  assert.match(await reviewPage.text(), /Publish a customer note\?/);

  const form = new URLSearchParams({ token, action: 'approve', quote: entry.quote, author: entry.author, context: entry.context, permission: 'written', source: 'owner-provided', rating: '5', approved_on: today });
  const approved = await handler(new Request('https://legacyai.space/api/frontdesk/testimonials', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }));
  assert.equal(approved.status, 200);
  const html = await approved.text();
  assert.match(html, /catalog\/testimonials\.json/);
  const printed = html.match(/<pre>([\s\S]*?)<\/pre>/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const parsed = JSON.parse(printed);
  assert.equal(validateTestimonial(parsed).ok, true);
  assert.equal(parsed.permission, 'written');
  assert.equal(parsed.rating, 5);
  assert.equal(JSON.parse(testimonialEntryJson(entry)).rating, 5);

  const invalid = new URLSearchParams({ token, action: 'approve', quote: entry.quote, author: entry.author, context: entry.context, permission: 'public-review', source: 'owner-provided', approved_on: today });
  const refused = await handler(new Request('https://legacyai.space/api/frontdesk/testimonials', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: invalid.toString() }));
  assert.equal(refused.status, 200);
  assert.match(await refused.text(), /Not ready: a public review needs the https link/);
});
