import { readFile } from 'node:fs/promises';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { editableReport, reportSectionLabels, readVoiceReportRequest, consumeVoiceReportLimits, voiceReportError } from './voice-report.js';

let fontFiles;
const fonts = () => fontFiles ||= Promise.all([
  readFile(new URL('./voice-report-fonts/DejaVuSans.ttf', import.meta.url)),
  readFile(new URL('./voice-report-fonts/DejaVuSans-Bold.ttf', import.meta.url)),
]);
const green = rgb(.10, .23, .18), ink = rgb(.15, .20, .18), muted = rgb(.40, .46, .41), line = rgb(.82, .85, .80);

export function wrapReportText(text, font, size, width) {
  const output = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph.trim()) { output.push(''); continue; }
    let current = '';
    for (const word of paragraph.trim().split(/\s+/u)) {
      const proposed = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(proposed, size) <= width) { current = proposed; continue; }
      if (current) output.push(current);
      current = '';
      for (const char of word) {
        if (current && font.widthOfTextAtSize(current + char, size) > width) { output.push(current); current = ''; }
        current += char;
      }
    }
    if (current) output.push(current);
  }
  return output;
}

export async function buildVoiceReportPdf(value) {
  const report = editableReport.parse(value), doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await fonts();
  const font = await doc.embedFont(regularBytes, { subset: true }), bold = await doc.embedFont(boldBytes, { subset: true });
  const characters = new Set(font.getCharacterSet()), boldCharacters = new Set(bold.getCharacterSet());
  const allText = [report.title, report.customer, report.location, report.jobDate, report.preparedBy, ...report.sections.map(s => s.content)].join('');
  if ([...allText].some(char => !/\s/u.test(char) && !characters.has(char.codePointAt(0))) || [...report.title].some(char => !/\s/u.test(char) && !boldCharacters.has(char.codePointAt(0)))) {
    throw Object.assign(new Error('One or more characters cannot be printed in this PDF. Please replace symbols or emoji in the report and try again.'), { status: 400 });
  }
  doc.setTitle(report.title); doc.setCreator('Legacy AI voice-to-report');
  doc.setProducer('Legacy AI');
  const width = 612, height = 792, margin = 50, textWidth = width - 2 * margin;
  let page, y;
  const addPage = () => {
    page = doc.addPage([width, height]); y = 700;
    page.drawRectangle({ x: 0, y: height - 12, width, height: 12, color: green });
    page.drawText('LEGACY AI', { x: margin, y: 748, size: 10, font: bold, color: green });
    page.drawText('VOICE TO REPORT', { x: 426, y: 748, size: 8, font, color: muted });
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
  addPage();
  drawLines(report.title, { size: 27, leading: 33, weight: bold, color: green }); y -= 16;
  const metadata = [['Customer', report.customer], ['Location', report.location], ['Visit date', report.jobDate], ['Prepared by', report.preparedBy]].filter(([, value]) => value);
  for (const [label, value] of metadata) {
    ensure(38);
    drawLines(label.toUpperCase(), { size: 7.5, leading: 13, weight: bold, color: muted });
    drawLines(value, { size: 10, leading: 15 }); y -= 7;
  }
  if (metadata.length) { y -= 9; ensure(20); page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: .7, color: line }); y -= 30; }
  for (const section of report.sections.filter(s => s.content)) {
    ensure(64);
    drawLines(reportSectionLabels[section.kind], { size: 12, leading: 23, weight: bold, color: green });
    drawLines(section.content); y -= 22;
  }
  const pages = doc.getPages();
  pages.forEach((sheet, i) => {
    sheet.drawLine({ start: { x: margin, y: 51 }, end: { x: width - margin, y: 51 }, thickness: .6, color: line });
    sheet.drawText('Prepared with Legacy AI  |  legacyai.space', { x: margin, y: 34, size: 7.5, font, color: muted });
    const pagination = `${i + 1} / ${pages.length}`;
    sheet.drawText(pagination, { x: width - margin - font.widthOfTextAtSize(pagination, 8), y: 34, size: 8, font, color: muted });
  });
  return doc.save();
}

export function createVoiceReportPdfHandler({ getStore, buildPdf = buildVoiceReportPdf, now = () => new Date() }) {
  return async request => {
    let phase = 'input';
    try {
      const report = editableReport.parse(await readVoiceReportRequest(request, 70000));
      phase = 'allowance';
      await consumeVoiceReportLimits(request, getStore(), now(), 'pdf');
      phase = 'pdf';
      const pdf = await buildPdf(report);
      return new Response(pdf, { headers: {
        'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="Job-report.pdf"',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      } });
    } catch (error) { return voiceReportError(error, phase); }
  };
}
