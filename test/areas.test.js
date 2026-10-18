import test from 'node:test';
import assert from 'node:assert/strict';
import { validateArea, validateAreaList, renderAreaPage, renderAreaIndex } from '../lib/areas.js';

const area = {
  slug: 'noblesville-in',
  town: 'Noblesville',
  county: 'Hamilton',
  state: 'IN',
  zips: ['46060', '46062'],
  landmarks: ['Historic Courthouse Square', 'Ruoff Music Center'],
  service_note: 'Same-day plumbing visits for Noblesville homes, including water heaters, drains, and emergency shutoffs.',
  source: 'https://www.noblesville.in.us/',
  verified_on: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
};

test('an area needs real facts, sources, and a recent verification date', () => {
  assert.equal(validateArea(area).ok, true);
  assert.equal(validateArea({ ...area, town: '' }).ok, false);
  assert.equal(validateArea({ ...area, town: 'TBD' }).ok, false);
  assert.equal(validateArea({ ...area, zips: [] }).ok, false);
  assert.equal(validateArea({ ...area, zips: ['4606'] }).ok, false);
  assert.equal(validateArea({ ...area, landmarks: [] }).ok, false);
  assert.equal(validateArea({ ...area, service_note: 'short' }).ok, false);
  assert.equal(validateArea({ ...area, source: '' }).ok, false);
  assert.equal(validateArea({ ...area, verified_on: '2019-01-01' }).ok, false);
  assert.equal(validateArea({ ...area, verified_on: '2999-01-01' }).ok, false);
  assert.equal(validateArea({ ...area, slug: 'Bad Slug' }).ok, false);
  assert.equal(validateArea({ ...area, source: 'https://example.com/facts' }).ok, false);
});

test('a list rejects duplicates and non-arrays', () => {
  assert.equal(validateAreaList([area]).ok, true);
  assert.equal(validateAreaList([area, area]).ok, false);
  assert.match(validateAreaList([area, area]).errors.join(' '), /duplicate slug/);
  assert.equal(validateAreaList('nope').ok, false);
});

test('rendering carries the facts, escapes input, and sets canonical and schema', () => {
  const html = renderAreaPage({ ...area, service_note: 'Plumbing help for <script>alert(1)</script> homes in Noblesville.' });
  assert.match(html, /Noblesville, IN/);
  assert.match(html, /Hamilton County/);
  assert.match(html, /46060, 46062/);
  assert.match(html, /Ruoff Music Center/);
  assert.match(html, /rel="canonical" href="https:\/\/legacyai\.space\/areas\/noblesville-in\/"/);
  assert.match(html, /application\/ld\+json/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
  const index = renderAreaIndex([area]);
  assert.match(index, /Noblesville/);
  assert.match(renderAreaIndex([]), /No area pages are configured yet/);
});
