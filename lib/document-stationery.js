import { readFile } from 'node:fs/promises';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { wrapReportText } from './voice-report-pdf.js';

// Branded stationery renderer for owner-approved documents (quote, invoice,
// field report, board memo). Pure visual module: it receives strings and
// already-validated decimal quantities, and computes only the display
// arithmetic needed to draw them. No schema validation, no database, no
// business policy decisions — due dates and reference numbers arrive ready.
let fontFiles;
const fonts = () => fontFiles ||= Promise.all([
  readFile(new URL('./voice-report-fonts/DejaVuSans.ttf', import.meta.url)),
  readFile(new URL('./voice-report-fonts/DejaVuSans-Bold.ttf', import.meta.url)),
]);
const green = rgb(.10, .23, .18), ink = rgb(.15, .20, .18), muted = rgb(.40, .46, .41), line = rgb(.82, .85, .80);

const KIND_TAGS = { quote: 'QUOTE', invoice: 'INVOICE', field_report: 'FIELD REPORT', board_request: 'BOARD MEMO' };

// Plain-decimal strings only; exponent or scientific forms fall back to zero so
// nothing unvalidated can reach the canvas. The expression below is identical to
// itemsTotalCents in lib/document-records.js — kept in lockstep so the branded
// totals always equal the registered invoice amount.
const toCents = value => {
  const [whole = '', frac = ''] = String(value ?? '').trim().split('.');
  return /^\d+$/.test(whole) && /^\d{0,2}$/.test(frac) ? Number(whole) * 100 + Number(frac.padEnd(2, '0')) : 0;
};
const lineCents = (qty, unitPrice) => {
  const text = String(qty ?? '').trim();
  const [whole = '', frac = ''] = text.split('.');
  if (!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac))) return 0;
  const den = 10 ** frac.length, num = Number(whole) * den + Number(frac || '0');
  // Identical to itemsTotalCents in lib/document-records.js — kept in lockstep
  // so the branded totals always equal the registered invoice amount.
  return Number((BigInt(toCents(unitPrice)) * BigInt(num) + BigInt(den >> 1)) / BigInt(den));
};
const money = cents => `$${(Number(cents) / 100).toFixed(2)}`;

export async function buildStationeryPdf({ kind, title, recipient, reference, issued, due, items, body, signed } = {}) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await fonts();
  const font = await doc.embedFont(regularBytes, { subset: true }), bold = await doc.embedFont(boldBytes, { subset: true });
  const characters = new Set(font.getCharacterSet()), boldCharacters = new Set(bold.getCharacterSet());
  const tag = KIND_TAGS[kind] || 'DOCUMENT', isInvoice = kind === 'invoice';
  const rows = (Array.isArray(items) ? items : []).filter(item => item && typeof item === 'object');
  const lines = rows.map(item => ({ description: String(item.description ?? ''), qty: String(item.qty ?? ''), amount: lineCents(item.qty, item.unit_price) }));
  const subtotal = lines.reduce((sum, entry) => sum + entry.amount, 0);
  const metadata = [
    ['Client email', recipient], ['Reference', reference], ['Issued', issued],
    ...(isInvoice && due ? [['Due', due]] : []),
    ...(isInvoice ? [['Payment terms', 'Net 7 · Tax $0.00']] : []),
  ].filter(([, value]) => value);
  // Unprintable glyphs are rejected, never replaced: dictated text against the
  // regular set, the title and the bold totals against the bold set.
  const regularText = [...metadata.map(([, value]) => value), ...lines.map(entry => `${entry.description} ${entry.qty}`), String(body ?? '')].join('');
  const boldText = `${title ?? ''}${money(subtotal)}${isInvoice ? '$0.00' : ''}`;
  const unprintable = (text, set) => [...text].some(char => !/\s/u.test(char) && !set.has(char.codePointAt(0)));
  if (unprintable(regularText, characters) || unprintable(boldText, boldCharacters)) {
    throw Object.assign(new Error('One or more characters cannot be printed in this PDF. Please replace symbols or emoji and try again.'), { status: 400 });
  }
  doc.setTitle(String(title ?? '')); doc.setCreator('Legacy AI documents');
  doc.setProducer('Legacy AI');
  const width = 612, height = 792, margin = 50, textWidth = width - 2 * margin;
  let page, y;
  const addPage = () => {
    page = doc.addPage([width, height]); y = 700;
    page.drawRectangle({ x: 0, y: height - 12, width, height: 12, color: green });
    page.drawText('LEGACY AI', { x: margin, y: 748, size: 10, font: bold, color: green });
    page.drawText(tag, { x: width - margin - font.widthOfTextAtSize(tag, 8), y: 748, size: 8, font, color: muted });
    page.drawLine({ start: { x: margin, y: 731 }, end: { x: width - margin, y: 731 }, thickness: .7, color: line });
  };
  const ensure = amount => { if (y - amount < 74) addPage(); };
  const drawLines = (text, { size = 10, leading = 16, weight = font, color = ink, x = margin, availableWidth = textWidth } = {}) => {
    for (const value of wrapReportText(text, weight, size, availableWidth)) {
      ensure(leading);
      if (value) page.drawText(value, { x, y, size, font: weight, color });
      y -= value ? leading : leading * .55;
    }
  };
  const rightText = (text, { size = 10, weight = font, color = ink, rightX = width - margin } = {}) =>
    page.drawText(text, { x: rightX - weight.widthOfTextAtSize(text, size), y, size, font: weight, color });
  const rule = () => page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: .7, color: line });
  addPage();
  drawLines(String(title ?? ''), { size: 27, leading: 33, weight: bold, color: green }); y -= 16;
  for (const [label, value] of metadata) {
    ensure(38);
    drawLines(label.toUpperCase(), { size: 7.5, leading: 13, weight: bold, color: muted });
    drawLines(value, { size: 10, leading: 15 }); y -= 7;
  }
  if (metadata.length) { y -= 9; ensure(20); rule(); y -= 30; }
  if (lines.length) {
    const descriptionWidth = Math.round(textWidth * .6), qtyRight = margin + descriptionWidth + 60;
    ensure(48);
    drawLines('DESCRIPTION', { size: 7.5, leading: 13, weight: bold, color: muted, availableWidth: descriptionWidth });
    page.drawText('QTY', { x: qtyRight - bold.widthOfTextAtSize('QTY', 7.5), y, size: 7.5, font: bold, color: muted });
    rightText('AMOUNT', { size: 7.5, weight: bold, color: muted });
    y -= 13; rule(); y -= 14;
    for (const entry of lines) {
      // Reserve the full wrapped height before capturing the row position, or a
      // page turn inside drawLines leaves qty/amount stranded on the prior page.
      ensure(wrapReportText(entry.description || '-', font, 10, descriptionWidth).length * 16 + 18);
      const top = y;
      drawLines(entry.description || '-', { availableWidth: descriptionWidth });
      page.drawText(entry.qty, { x: qtyRight - font.widthOfTextAtSize(entry.qty, 10), y: top, size: 10, font, color: ink });
      page.drawText(money(entry.amount), { x: width - margin - font.widthOfTextAtSize(money(entry.amount), 10), y: top, size: 10, font, color: ink });
      ensure(16); rule(); y -= 16;
    }
    y -= 8; ensure(64); rule(); y -= 24;
    const totalsLabel = { x: margin + descriptionWidth, size: 10, weight: bold, color: ink };
    const totalsRow = (label, value) => {
      page.drawText(label, { x: totalsLabel.x, y, size: 10, font: bold, color: ink });
      rightText(value, { size: 10, weight: bold, color: ink });
      y -= 18;
    };
    totalsRow('Subtotal', money(subtotal));
    if (isInvoice) totalsRow('Tax', money(0));
    totalsRow('Total', money(subtotal));
    y -= 14;
  }
  if (body) {
    ensure(64);
    drawLines('What was discussed', { size: 12, leading: 23, weight: bold, color: green });
    drawLines(String(body)); y -= 22;
  }
  // A signed copy carries the same branded body; signature branding is a
  // separately approved follow-up, so `signed` is accepted but not rendered yet.
  void signed;
  const pages = doc.getPages();
  pages.forEach((sheet, i) => {
    sheet.drawLine({ start: { x: margin, y: 51 }, end: { x: width - margin, y: 51 }, thickness: .6, color: line });
    sheet.drawText('Prepared with Legacy AI  |  legacyai.space', { x: margin, y: 34, size: 7.5, font, color: muted });
    const pagination = `${i + 1} / ${pages.length}`;
    sheet.drawText(pagination, { x: width - margin - font.widthOfTextAtSize(pagination, 8), y: 34, size: 8, font, color: muted });
  });
  return doc.save();
}
