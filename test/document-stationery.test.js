import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, decodePDFRawStream } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { buildStationeryPdf } from '../lib/document-stationery.js';

// Text runs are drawn with subset glyphs (no ToUnicode map), so assertions read
// the decoded content stream: every drawn string has a distinct position, size,
// weight and glyph count. Expected x positions are computed by measuring the
// exact expected string with the same fonts, which pins both the text and the
// layout (e.g. right alignment) without re-implementing the renderer.
const fontBytes = (bold = false) => readFile(new URL(`../lib/voice-report-fonts/DejaVuSans${bold ? '-Bold' : ''}.ttf`, import.meta.url));
const measure = async (text, size, bold = false) => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await fontBytes(bold), { subset: true });
  return font.widthOfTextAtSize(text, size);
};
const RIGHT = 612 - 50;
const runsOf = ops => [...ops.matchAll(/BT\s+([\d.]+) ([\d.]+) ([\d.]+) rg\s+\/DejaVuSans(-Bold)?-\d+ ([\d.]+) Tf\s+\d+ TL\s+1 0 0 1 ([\d.]+) ([\d.]+) Tm\s+<([0-9a-fA-F]+)> Tj\s+T\*\s+ET/g)]
  .map(m => ({ color: `${m[1]} ${m[2]} ${m[3]}`, bold: Boolean(m[4]), size: Number(m[5]), x: Number(m[6]), y: Number(m[7]), glyphs: m[8].length / 4 }));
const INK = '0.15 0.2 0.18', MUTED = '0.4 0.46 0.41';
const runs = async (bytes, pageIndex = 0) => {
  const pdf = await PDFDocument.load(bytes);
  const contents = pdf.context.lookup(pdf.getPages()[pageIndex].node.get(PDFName.of('Contents')).get(0));
  return runsOf(Buffer.from(decodePDFRawStream(contents).decode()).toString('latin1'));
};
const near = (a, b) => Math.abs(a - b) < 0.02;

const invoice = {
  kind: 'invoice', title: 'Kitchen remodel invoice', recipient: 'customer@example.com',
  reference: 'INV-001', issued: '2026-11-22', due: '2026-11-29',
  items: [{ description: 'Cabinet install labor', qty: '4', unit_price: '85.00' }, { description: 'Hardware kit', qty: '2', unit_price: '19.99' }],
  body: 'Replaced cabinets and hardware as discussed on site.',
};

test('branded bytes are a real PDF with embedded fonts and the document title', async () => {
  const bytes = Buffer.from(await buildStationeryPdf(invoice));
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.length > 15000, 'fonts are embedded, not fetched by the reader');
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getTitle(), 'Kitchen remodel invoice');
  assert.equal(pdf.getPageCount(), 1);
});

test('the kind tag renders at the masthead right edge for every kind', async () => {
  const tags = { quote: 'QUOTE', invoice: 'INVOICE', field_report: 'FIELD REPORT', board_request: 'BOARD MEMO' };
  for (const [kind, tag] of Object.entries(tags)) {
    const tagged = await runs(await buildStationeryPdf({ ...invoice, kind, items: [], due: null }));
    const tagRun = tagged.find(run => run.y === 748 && run.size === 8 && run.color === MUTED && !run.bold);
    assert.ok(tagRun, `${kind} draws a masthead tag`);
    assert.ok(near(tagRun.x, RIGHT - await measure(tag, 8)), `${kind} tag '${tag}' is right-aligned`);
  }
  const fallback = await runs(await buildStationeryPdf({ ...invoice, kind: 'other', items: [], due: null }));
  assert.ok(near(fallback.find(run => run.y === 748 && run.size === 8).x, RIGHT - await measure('DOCUMENT', 8)));
});

test('metadata rows appear only when present and invoices carry the Net 7 terms', async () => {
  const branded = await runs(await buildStationeryPdf(invoice));
  // Labels: CLIENT EMAIL, REFERENCE, ISSUED, DUE, PAYMENT TERMS (plus the items DESCRIPTION header).
  const labels = branded.filter(run => run.bold && run.size === 7.5 && run.color === MUTED && run.x === 50).map(run => run.glyphs);
  assert.deepEqual(labels, [...['CLIENT EMAIL', 'REFERENCE', 'ISSUED', 'DUE', 'PAYMENT TERMS'].map(text => text.length), 'DESCRIPTION'.length]);
  for (const [text, glyphCount] of [['customer@example.com', 20], ['INV-001', 7], ['2026-11-22', 10], ['2026-11-29', 10], ['Net 7 · Tax $0.00', 17]]) {
    assert.ok(branded.some(run => run.x === 50 && run.size === 10 && run.color === INK && !run.bold && run.glyphs === glyphCount), `metadata value '${text}' drawn`);
  }
  const quote = await runs(await buildStationeryPdf({ ...invoice, kind: 'quote', due: null, items: [] }));
  const quoteLabels = quote.filter(run => run.bold && run.size === 7.5 && run.color === MUTED && run.x === 50).map(run => run.glyphs);
  assert.deepEqual(quoteLabels, ['CLIENT EMAIL', 'REFERENCE', 'ISSUED'].map(text => text.length), 'no Due or payment-terms row without invoice kind');
});

test('items draw left descriptions, a middle qty column, right-aligned amounts, and exact totals', async () => {
  const branded = await runs(await buildStationeryPdf(invoice));
  const descriptionWidth = Math.round((612 - 100) * .6), qtyRight = 50 + descriptionWidth + 60;
  const total = 4 * 8500 + 2 * 1999; // 37998
  const [w340, w3998, w4, w2, w37998, w0] = await Promise.all([
    measure('$340.00', 10), measure('$39.98', 10), measure('4', 10), measure('2', 10), measure('$379.98', 10, true), measure('$0.00', 10, true),
  ]);
  for (const [text, amount, qty, amountX, qtyX] of [['Cabinet install labor', '$340.00', '4', RIGHT - w340, qtyRight - w4], ['Hardware kit', '$39.98', '2', RIGHT - w3998, qtyRight - w2]]) {
    assert.ok(branded.some(run => run.x === 50 && run.color === INK && run.glyphs === text.length), `'${text}' drawn left`);
    assert.ok(branded.some(run => near(run.x, amountX) && run.color === INK), `${amount} right-aligned`);
    assert.ok(branded.some(run => near(run.x, qtyX) && run.color === INK), 'qty in its middle column');
  }
  const totals = branded.filter(run => run.bold && run.size === 10 && run.color === INK);
  assert.equal(totals.length, 6, 'three label/value pairs: Subtotal, Tax, Total');
  assert.ok(totals.some(run => run.x === 50 + descriptionWidth && run.glyphs === 'Subtotal'.length));
  assert.ok(totals.some(run => run.x === 50 + descriptionWidth && run.glyphs === 'Tax'.length));
  assert.ok(totals.some(run => run.x === 50 + descriptionWidth && run.glyphs === 'Total'.length));
  assert.ok(totals.some(run => near(run.x, RIGHT - w37998)), 'total $379.98 right-aligned');
  assert.ok(totals.some(run => near(run.x, RIGHT - w0)), 'tax $0.00 row present for invoices');
  assert.ok(near(totals.at(-1).x, RIGHT - w37998), 'Total carries the subtotal amount, right-aligned with the amounts column');
  // A quote drops the tax row: two label/value pairs only.
  const quoteTotals = (await runs(await buildStationeryPdf({ ...invoice, kind: 'quote', due: null }))).filter(run => run.bold && run.size === 10 && run.color === INK);
  assert.equal(quoteTotals.length, 4, 'Subtotal and Total only');
  assert.equal(total, 37998);
});

test('unprintable glyphs are rejected with status 400, never replaced', async () => {
  await assert.rejects(buildStationeryPdf({ ...invoice, body: 'Condition \u{1F6CC} noted' }), error => error.status === 400);
  await assert.rejects(buildStationeryPdf({ ...invoice, items: [{ description: '部件', qty: '1', unit_price: '1.00' }] }), error => error.status === 400);
  await assert.rejects(buildStationeryPdf({ ...invoice, title: '𝖠 report' }), error => error.status === 400);
  const bytes = await buildStationeryPdf({ ...invoice, title: 'Café quote — final' });
  assert.equal(Buffer.from(bytes).subarray(0, 5).toString(), '%PDF-');
});

test('long dictated bodies paginate with footers on every page', async () => {
  const bytes = Buffer.from(await buildStationeryPdf({ ...invoice, items: [], due: null, body: 'Reviewed the work area and recorded the observed condition.\n\n'.repeat(120) }));
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 3, 'content paginates instead of clipping');
  for (const index of [0, 1, pdf.getPageCount() - 1]) {
    const pageRuns = await runs(bytes, index);
    const footer = pageRuns.find(run => run.y === 34 && run.size === 7.5 && run.color === MUTED);
    assert.ok(footer && footer.glyphs === 'Prepared with Legacy AI  |  legacyai.space'.length, `page ${index + 1} carries the footer`);
    const pagination = `${index + 1} / ${pdf.getPageCount()}`;
    const pageMarker = pageRuns.find(run => run.y === 34 && run.size === 8 && run.color === MUTED);
    assert.ok(pageMarker && near(pageMarker.x, RIGHT - await measure(pagination, 8)) && pageMarker.glyphs === pagination.length, `page ${index + 1} shows '${pagination}'`);
  }
});
