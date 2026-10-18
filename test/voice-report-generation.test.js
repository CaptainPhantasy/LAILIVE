import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceReportGeneration, voiceReportUsageRecord, reportReview, reportRepairInstructions } from '../lib/voice-report-generation.js';
import { groundedReport } from '../lib/voice-report.js';

const note = 'Um, I ran the cable 30 feet—no, sorry, 35 feet—and got grease. Didn’t see any roots. It drains now. Camera check recommended, haven’t done that yet.';
const draft = { customer: '', location: '', jobDate: '', preparedBy: '', sections: [
  { kind: 'work_completed', content: 'Ran the cable 35 feet and removed grease.', excerpts: ['Um, I ran the cable 30 feet—no, sorry, 35 feet—and got grease.'] },
  { kind: 'observations', content: 'No roots were observed. The drain was flowing after the work.', excerpts: ['Didn’t see any roots.', 'It drains now.'] },
  { kind: 'recommendations', content: 'A camera inspection is recommended and has not been completed.', excerpts: ['Camera check recommended, haven’t done that yet.'] },
] };
const passed = Object.fromEntries(Object.keys(reportReview.shape).map(key => [key, true]));
const providerResult = (output, id) => ({ output, totalUsage: { inputTokens: 300, outputTokens: 140, inputTokenDetails: { cacheReadTokens: 100 } }, providerMetadata: { gateway: { generationId: id, cost: '0.0008' } }, finishReason: 'stop' });

test('messy note becomes professional prose only after a separate factual review; logs contain cost and IDs but no notes', async () => {
  const calls = [], logs = [];
  const generate = createVoiceReportGeneration({ env: {}, gateway: name => name, log: value => logs.push(value), generate: async options => {
    calls.push(options);
    return calls.length === 1 ? providerResult(draft, 'generation-draft-1') : providerResult(passed, 'generation-review-2');
  } });
  const output = await generate(note), report = groundedReport(output, note);
  assert.equal(calls.length, 2);
  assert.match(calls[0].instructions, /Remove filler/);
  assert.match(calls[1].instructions, /fidelity check/);
  assert.equal(calls[0].abortSignal, calls[1].abortSignal, 'both calls share the overall timeout');
  assert.equal(JSON.parse(calls[1].prompt).proposedReport.sections.find(s => s.kind === 'work_completed').content, 'Ran the cable 35 feet and removed grease.');
  assert.match(report.sections.find(s => s.kind === 'recommendations').content, /has not been completed/);
  assert.equal(logs.at(-1).costUsd, 0.0016);
  assert.deepEqual(logs.at(-1).generationIds, ['generation-draft-1', 'generation-review-2']);
  assert.doesNotMatch(JSON.stringify(logs), /grease|camera|roots|35 feet|Um,/i);
});

test('failed meaning check prevents a polished but unfaithful report', async () => {
  let calls = 0;
  const generate = createVoiceReportGeneration({ env: {}, gateway: name => name, log: () => {}, generate: async () => ++calls === 1 ? providerResult(draft, 'one') : providerResult({ ...passed, uncertaintyAndNegationPreserved: false }, 'two') });
  await assert.rejects(generate(note), /source-fidelity review/);
  assert.equal(calls, 2);
});

test('fabricated numbers fail before another provider call; failed provider details stay out of telemetry', async () => {
  let calls = 0; const logs = [];
  const invalid = structuredClone(draft); invalid.sections[0].content = 'Ran the cable 100 feet.';
  const generate = createVoiceReportGeneration({ env: {}, gateway: name => name, log: record => logs.push(record), generate: async () => { calls++; return providerResult(invalid, 'bad-draft'); } });
  await assert.rejects(generate(note), /quantity outside/);
  assert.equal(calls, 1);
  assert.equal(logs.at(-1).event, 'voice_report_failed');
  assert.doesNotMatch(JSON.stringify(logs), /grease|100 feet/);
});

test('unknown cost remains unknown rather than being reported as free', () => {
  const record = voiceReportUsageRecord({ output: { private: 'do not log' } }, { model: 'example/model', phase: 'draft', requestId: 'test' });
  assert.equal(record.costUsd, null);
  assert.equal(record.costBasis, 'unavailable');
  assert.equal(record.generationId, null);
  assert.doesNotMatch(JSON.stringify(record), /do not log/);
});

test('a grounding rejection gets one exact-quote repair before the fidelity review', async () => {
  const messy = 'so the job started with the. build-out plan of the. implementation where we were going to try to get the. 54. items working. We picked six.';
  const bad = { customer: '', location: '', jobDate: '', preparedBy: '', sections: [{ kind: 'summary', content: 'The work began with an implementation plan for 54 items; six were selected.', excerpts: ['an implementation plan for 54 items'] }] };
  const good = { customer: '', location: '', jobDate: '', preparedBy: '', sections: [{ kind: 'summary', content: 'The work began with a build-out plan for 54 items; six were selected.', excerpts: ['the build-out plan of the implementation where we were going to try to get the 54 items working.'] }] };
  const calls = [], logs = [];
  const generate = createVoiceReportGeneration({ env: {}, gateway: name => name, log: value => logs.push(value), generate: async options => {
    calls.push(options);
    return calls.length === 1 ? providerResult(bad, 'draft') : calls.length === 2 ? providerResult(good, 'repair') : providerResult(passed, 'review');
  } });
  const output = await generate(messy);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].instructions, reportRepairInstructions);
  assert.equal(output.sections[0].excerpts[0], good.sections[0].excerpts[0]);
  assert.equal(logs.at(-1).event, 'voice_report_complete');
  assert.doesNotMatch(JSON.stringify(logs), /build-out|implementation|54 items/i);
});
