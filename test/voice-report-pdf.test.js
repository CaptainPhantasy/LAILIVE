import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { buildVoiceReportPdf, createVoiceReportPdfHandler } from '../lib/voice-report-pdf.js';

const report = { title: 'Kitchen service report', customer: 'Maria López', location: '214 Oak Street', jobDate: '', preparedBy: 'André', sections: [
  { kind: 'observations', content: 'Customer reported a dripping kitchen tap. No visible damage to the tap body.' },
  { kind: 'work_completed', content: 'Replaced the washer, reassembled the tap, and checked it five times. No dripping during the final check.' },
  { kind: 'next_steps', content: 'Customer to call if the leak returns. No further work was scheduled.' },
] };
const req = (value = report) => new Request('https://legacyai.space/api/voice-report-pdf', { method: 'POST', headers: { origin: 'https://legacyai.space', 'content-type': 'application/json' }, body: JSON.stringify(value) });

test('download is a real readable PDF with embedded fonts and the visitor’s title', async () => {
  const bytes = await buildVoiceReportPdf(report);
  assert.equal(Buffer.from(bytes).subarray(0, 5).toString(), '%PDF-');
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1);
  assert.equal(pdf.getTitle(), 'Kitchen service report');
  assert.ok(bytes.length > 15000, 'fonts are embedded, not fetched by the reader');
});

test('long reports paginate instead of clipping or silently losing paragraphs', async () => {
  const bytes = await buildVoiceReportPdf({ ...report, sections: [{ kind: 'observations', content: 'Reviewed the work area and recorded the observed condition.\n\n'.repeat(90) }] });
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 3);
  assert.ok(pdf.getPageCount() <= 8);
});

test('edited content reaches the PDF builder without invoking private owner workflows', async () => {
  let rendered, rules;
  const handler = createVoiceReportPdfHandler({ getStore: () => ({ consumeLimits: async value => { rules = value; } }), buildPdf: async value => { rendered = value; return new TextEncoder().encode('%PDF-1.7\nfixture'); } });
  const edited = { ...report, title: 'My edited title', customer: 'María', sections: [{ kind: 'next_steps', content: '<script>alert("untrusted text")</script> is literal report text.' }] };
  const response = await handler(req(edited));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-disposition'), /^attachment/);
  assert.deepEqual(rendered, edited);
  assert.equal(rules[0].limit, 30);
});

test('unprintable glyphs are never silently replaced, and missing content is rejected', async () => {
  await assert.rejects(buildVoiceReportPdf({ ...report, customer: '𠀋' }), /cannot be printed/);
  await assert.rejects(buildVoiceReportPdf({ ...report, title: '𝖠 report' }), /cannot be printed/);
  let calls = 0;
  const handler = createVoiceReportPdfHandler({ getStore: () => { calls++; return {}; } });
  assert.equal((await handler(req({ ...report, sections: [] }))).status, 400);
  assert.equal(calls, 0);
});
