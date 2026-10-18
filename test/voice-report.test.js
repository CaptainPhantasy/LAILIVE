import test from 'node:test';
import assert from 'node:assert/strict';
import { groundedReport, reportInstructions, reportSectionLabels, createVoiceReportHandler } from '../lib/voice-report.js';

const note = 'Visited 214 Oak Street for Maria López. Found a loose handle. Tightened the handle and tested it three times. Customer will call if the leak returns.';
const extraction = { customer: 'Maria López', location: '214 Oak Street', jobDate: '', preparedBy: '', sections: [
  { kind: 'observations', content: 'A loose handle was found.', excerpts: ['Found a loose handle.'] },
  { kind: 'work_completed', content: 'Tightened the handle and tested it three times.', excerpts: ['Tightened the handle and tested it three times.'] },
  { kind: 'next_steps', content: 'Customer will call if the leak returns.', excerpts: ['Customer will call if the leak returns.'] },
] };
const request = (body = { transcript: note }, headers = {}) => new Request('https://legacyai.space/api/voice-report', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://legacyai.space', 'x-forwarded-for': '192.0.2.42', ...headers }, body: JSON.stringify(body) });

test('organizes only supplied facts and never fills in an unknown visit date', () => {
  const report = groundedReport(extraction, note);
  assert.equal(report.customer, 'Maria López');
  assert.equal(report.location, '214 Oak Street');
  assert.equal(report.jobDate, '');
  assert.equal(report.sections[1].content, 'Tightened the handle and tested it three times.');
  assert.throws(() => groundedReport({ ...extraction, jobDate: '2026-10-17' }, note), /supplied note/);
  assert.throws(() => groundedReport({ ...extraction, sections: [{ kind: 'work_completed', content: 'Replaced the assembly.', excerpts: ['Replaced the entire assembly.'] }] }, note), /supplied note/);
});

test('the generation instructions isolate dictation as data and preserve uncertainty and negation', () => {
  assert.match(reportInstructions, /not instructions/);
  assert.match(reportInstructions, /negation/);
  assert.match(reportInstructions, /planned work.*completed/);
});

test('exact substrings cannot discard negation or conditions around the work', () => {
  const negative = 'I did not replace the pump because the customer declined the work.';
  assert.throws(() => groundedReport({ customer: '', location: '', jobDate: '', preparedBy: '', sections: [{ kind: 'work_completed', content: 'Replaced the pump.', excerpts: ['replace the pump'] }] }, negative), /shortened a sentence/);
  const conditional = 'If the customer approves, we will replace the pump.';
  assert.throws(() => groundedReport({ customer: '', location: '', jobDate: '', preparedBy: '', sections: [{ kind: 'work_completed', content: 'Will replace the pump.', excerpts: ['we will replace the pump.'] }] }, conditional), /shortened a sentence/);
  assert.equal(groundedReport({ customer: '', location: '', jobDate: '', preparedBy: '', sections: [{ kind: 'observations', content: negative, excerpts: [negative] }] }, negative).sections[0].content, negative);
});

test('messy dictation punctuation and a project narrative use summary sections', () => {
  const messy = 'so the job started with the. build-out plan of the. implementation where we were going to try to get the. 54. items working. We picked six.';
  const draft = { customer: '', location: '', jobDate: '', preparedBy: '', sections: [{ kind: 'summary', content: 'The work began with a build-out plan to make 54 items work; six were selected.', excerpts: ['the build-out plan of the implementation where we were going to try to get the 54 items working.'] }] };
  const report = groundedReport(draft, messy);
  assert.equal(report.sections[0].kind, 'summary');
  assert.equal(reportSectionLabels.summary, 'Summary');
});

test('professional prose cannot introduce new numeric quantities', () => {
  const source = 'Ran the cable 35 feet and removed grease.';
  const candidate = { customer: '', location: '', jobDate: '', preparedBy: '', sections: [{ kind: 'work_completed', content: 'Ran the cable 50 feet and removed grease.', excerpts: [source] }] };
  assert.throws(() => groundedReport(candidate, source), /quantity outside/);
  candidate.sections[0].content = 'The cable was run 35 feet, removing grease.';
  assert.equal(groundedReport(candidate, source).sections[0].content, candidate.sections[0].content);
});

test('public report accepts no owner authorization, consumes persistent limits before generation and returns no source secrets', async () => {
  const calls = [];
  const handler = createVoiceReportHandler({ getStore: () => ({ consumeLimits: async rules => { calls.push('limit'); assert.equal(rules.length, 3); assert.equal(rules[0].limit, 6); assert.equal(rules[2].limit, 100); assert.ok(!rules[0].key.includes('192.0.2.42')); } }), generate: async input => { calls.push('generate'); assert.equal(input, note); return extraction; } });
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['limit', 'generate']);
  assert.equal((await response.json()).report.customer, 'Maria López');
});

test('the report handler returns a review warning without blocking the report', async () => {
  const handler = createVoiceReportHandler({ getStore: () => ({ consumeLimits: async () => {} }), generate: async () => ({ ...extraction, review: { passed: false, failedChecks: ['allStatementsSupported'] } }) });
  const response = await handler(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.report.customer, 'Maria López');
  assert.deepEqual(body.review, { passed: false, failedChecks: ['allStatementsSupported'] });
});

test('foreign origins, oversized notes and extra fields are rejected before paid work', async () => {
  let calls = 0;
  const handler = createVoiceReportHandler({ getStore: () => { calls++; throw new Error('unexpected'); }, generate: async () => { calls++; } });
  assert.equal((await handler(request({}, { origin: 'https://elsewhere.test' }))).status, 403);
  assert.equal((await handler(request({ transcript: 'x'.repeat(6001) }))).status, 400);
  assert.equal((await handler(request({ transcript: note, ownerToken: 'untrusted' }))).status, 400);
  assert.equal(calls, 0);
});

test('generation failure and fabricated provider output never return a successful report', async () => {
  const getStore = () => ({ consumeLimits: async () => {} });
  const failing = createVoiceReportHandler({ getStore, generate: async () => { throw new Error('token PRIVATE provider detail'); } });
  const response = await failing(request());
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /PRIVATE/);
  const fabricated = createVoiceReportHandler({ getStore, generate: async () => ({ ...extraction, customer: 'Different Person' }) });
  assert.equal((await fabricated(request())).status, 502);
});

test('persistent allowance failure cannot fall back to unmetered generation', async () => {
  let called = false;
  const handler = createVoiceReportHandler({ getStore: () => ({ consumeLimits: async () => { throw Object.assign(new Error('allowance reached'), { status: 429 }); } }), generate: async () => { called = true; } });
  assert.equal((await handler(request())).status, 429);
  assert.equal(called, false);
});
