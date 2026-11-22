import { scryptSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { PDFDocument, PDFName, decodePDFRawStream } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { createOwnerDocumentHandler } from '../lib/owner-documents.js';
import { createInvoiceHandler } from '../lib/invoices.js';
import { createQuotePhotoHandler } from '../lib/quote-photo.js';
import { createAssistantHandlers } from '../lib/assistant.js';
import { signOwnerToken } from '../lib/owner-documents-core.js';
import { net7Due } from '../lib/document-records.js';

// Structured-capture dry run: simulates the full Darla save_owner_draft flow for
// every document kind through the real handlers and real record upserts, against
// an in-memory PGlite database with the checked-in migrations applied. Zero
// network: the mailer is a collector, the Board generator is synthetic, and no
// fetch call exists in this script. Rendered PDFs land in --out (default under
// .tmp/, a working-tree verification artifact, never committed).

const argOut = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : '.tmp/structured-capture-dry-run';
const outDir = path.resolve(argOut);
await mkdir(outDir, { recursive: true });

const pg = new PGlite();
const db = drizzle(pg);
for (const file of ['0000_legacy_crm.sql', '0001_visitor_contacts.sql', '0002_private_tables.sql']) {
  await pg.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
}

const salt = '0123456789abcdef0123456789abcdef';
const env = {
  RECEPTIONIST_WEBHOOK_SECRET: 'synthetic-webhook-key-never-deploy',
  RECEPTIONIST_SESSION_SECRET: 'synthetic-session-key-never-deploy-24ch',
  FRONTDESK_OWNER_PIN_HASH: `${salt}:${scryptSync('123456', salt, 32).toString('hex')}`,
  FRONTDESK_PUBLIC_ORIGIN: 'https://legacyai.space',
  CRON_SECRET: 'synthetic-cron-key-never-deploy',
  INVOICE_SECRET: 'synthetic-invoice-key-never-deploy',
  QUOTE_SECRET: 'synthetic-quote-key-never-deploy',
};
const mailLog = [];
const mail = async message => { mailLog.push(message); return true; };
const generateBoard = async question => `Recommendation: hold the diagnostic fee.\nRisks: price-sensitive callers.\nQuestion on file: ${question.slice(0, 40)}`;
const limits = new Map();
const limiter = { consumeLimits: async rules => { for (const rule of rules) { if ((limits.get(rule.key) || 0) >= rule.limit) throw Object.assign(new Error('limit'), { status: 429 }); limits.set(rule.key, (limits.get(rule.key) || 0) + 1); } } };

const { owner: ownerDictation, document: ownerReview } = createOwnerDocumentHandler({ getDb: () => db, env, mail, generateBoard });
createInvoiceHandler({ getDb: () => db, mail, env });
const quotes = createQuotePhotoHandler({ getDb: () => db, mail, env, describe: async () => { throw new Error('vision off in the dry run'); } });
const assistant = createAssistantHandlers({ getDb: () => db, getStore: () => limiter, mail, env, now: () => new Date('2026-07-01T22:03:00Z') });

const json = async response => ({ status: response.status, body: await response.json() });
const results = [];
const check = async (kind, name, run) => {
  try { await run(); results.push([kind, name, 'PASS', '']); }
  catch (error) { results.push([kind, name, 'FAIL', String(error && error.message || error).slice(0, 200)]); }
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const count = async query => (await pg.query(query)).rows[0].n;

// Text runs are drawn with subset glyphs (no ToUnicode map), so the PDF evidence
// below reads positions, sizes, weights and glyph counts from the decoded
// content stream and matches them against strings measured with the same fonts.
const runsOf = ops => [...ops.matchAll(/BT\s+([\d.]+) ([\d.]+) ([\d.]+) rg\s+\/DejaVuSans(-Bold)?-\d+ ([\d.]+) Tf\s+\d+ TL\s+1 0 0 1 ([\d.]+) ([\d.]+) Tm\s+<([0-9a-fA-F]+)> Tj\s+T\*\s+ET/g)]
  .map(match => ({ color: `${match[1]} ${match[2]} ${match[3]}`, bold: Boolean(match[4]), size: Number(match[5]), x: Number(match[6]), y: Number(match[7]), glyphs: match[8].length / 4 }));
const measure = await (async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(await readFile(new URL('../lib/voice-report-fonts/DejaVuSans.ttf', import.meta.url)), { subset: true });
  const bold = await doc.embedFont(await readFile(new URL('../lib/voice-report-fonts/DejaVuSans-Bold.ttf', import.meta.url)), { subset: true });
  return (text, size, isBold) => (isBold ? bold : regular).widthOfTextAtSize(text, size);
})();
const INK = '0.15 0.2 0.18';
const near = (a, b) => Math.abs(a - b) < 0.02;

// Asserts the branded artifact is real, embedded, carries the reference and
// Net-7 metadata rows, and right-aligns the totals column; returns quotable
// evidence lines describing exactly what was observed.
const brandedEvidence = async (bytes, { title, reference, due, total }) => {
  const pdf = await PDFDocument.load(bytes);
  const contents = pdf.context.lookup(pdf.getPages()[0].node.get(PDFName.of('Contents')).get(0));
  const runs = runsOf(Buffer.from(decodePDFRawStream(contents).decode()).toString('latin1'));
  const lines = [`rendered: ${bytes.length} bytes, ${pdf.getPageCount()} page(s), title "${pdf.getTitle()}"`];
  assert(pdf.getTitle() === title, `PDF title is ${pdf.getTitle()}`);
  assert(bytes.length > 15000, `branded PDF too small (${bytes.length} bytes) — fonts must be embedded`);
  const values = runs.filter(run => run.x === 50 && run.size === 10 && !run.bold && run.color === INK).map(run => run.glyphs);
  const expectations = [['client email', 20], ...(reference ? [['reference', reference.length]] : []), ['issued', 10], ...(due ? [['due', due.length]] : [])];
  if (runs.some(run => run.bold && run.size === 7.5 && run.glyphs === 'PAYMENT TERMS'.length)) expectations.push(['payment terms', 'Net 7 · Tax $0.00'.length]);
  for (const [label, glyphCount] of expectations) assert(values.includes(glyphCount), `metadata value for ${label} (${glyphCount} glyphs) missing at x=50`);
  lines.push(`metadata values drawn at x=50: glyph counts [${values.join(', ')}] cover client email(20)${reference ? `, reference(${reference.length}=${reference})` : ''}, issued(10)${due ? `, due(${due})` : ''}${expectations.some(([label]) => label === 'payment terms') ? ', Net 7 terms(17)' : ''}`);
  if (total) {
    const totalX = 562 - measure(total, 10, true);
    const totalRun = runs.find(run => run.bold && run.size === 10 && run.color === INK && near(run.x, totalX));
    assert(totalRun, `total ${total} not right-aligned at x=${totalX.toFixed(2)}`);
    const labelCount = runs.filter(run => run.bold && run.size === 10 && run.color === INK && run.glyphs === 'Subtotal'.length).length;
    lines.push(`totals: bold value at x=${totalRun.x.toFixed(2)} = 562 - width("${total}") (right-aligned); Subtotal label drawn ${labelCount}x`);
  }
  return lines;
};

// PIN handshake → SWAIG tool URL for the dictation session.
const handshake = await json(await ownerDictation(new Request('https://legacyai.space/api/frontdesk/owner', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-frontdesk-secret': env.RECEPTIONIST_WEBHOOK_SECRET }, body: JSON.stringify({ call: { call_id: 'dryrun-owner-call', from: '+18123405761' }, vars: { prompt_value: '123456' } }) })));
if (handshake.status !== 200) throw new Error(`handshake failed: ${JSON.stringify(handshake.body)}`);
const tool = handshake.body.sections.main.find(step => step.ai).ai.SWAIG.functions[0];

const save = async arguments_ => json(await ownerDictation(new Request(tool.web_hook_url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ call_id: 'dryrun-owner-call', argument: { parsed: [arguments_] } }),
})));
const documentLink = index => mailLog.slice(index).map(message => message.body.match(/https:\/\/legacyai\.space\/api\/frontdesk\/document\?token=\S+/)[0]).find(Boolean);
const approveForm = (title, content) => { const form = new FormData(); form.set('action', 'approve'); form.set('version', '1'); form.set('title', title); form.set('content', content); return form; };
const approveDraft = async (mailIndex, title, content) => ownerReview(new Request(documentLink(mailIndex), { method: 'POST', body: approveForm(title, content) }));
const downloadPdf = async (mailIndex, title, content) => {
  const link = documentLink(mailIndex);
  const approved = await approveDraft(mailIndex, title, content);
  assert(approved.status === 303, `approve failed: ${approved.status} ${approved.status >= 400 ? JSON.stringify(await approved.json()) : ''}`);
  const response = await ownerReview(new Request(`${link}&pdf=1`));
  assert(response.status === 200, `download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

const mailsAtStart = mailLog.length;
const items = [{ description: 'Cabinet doors', qty: 12, unit_price: 85 }, { description: 'Install labor', qty: 4, unit_price: 65 }];
const dueToday = net7Due(new Date());

await check('handshake', 'PIN session → SWAIG carries optional items; prompt keeps the manual-invoice sentence', async () => {
  assert(tool.parameters.required.join(',') === 'kind,title,content', 'items must stay optional');
  assert(tool.parameters.properties.items?.type === 'array' && tool.parameters.properties.items.maxItems === 50, 'items schema missing');
  assert(!JSON.stringify(handshake.body).includes('123456'), 'the PIN leaked into the SWML payload');
  assert(/never invent prices/.test(handshake.body.sections.main.find(step => step.ai).ai.prompt.text), 'prompt sentence missing');
});

await check('quote (with items)', 'save → approve → Q-001 + one contact + one inquiry + branded PDF', async () => {
  const saved = await save({ kind: 'quote', title: 'Cabinet refacing quote', content: 'Refacing the upper cabinets with new doors and hinges.', recipient: 'customer@example.com', items });
  assert(saved.status === 200 && /saved/.test(saved.body.response), `save failed: ${JSON.stringify(saved.body)}`);
  const bytes = await downloadPdf(mailsAtStart, 'Cabinet refacing quote', 'Refacing the upper cabinets with new doors and hinges.');
  assert(await count('SELECT count(*)::int AS n FROM legacy_contacts') === 1, 'contact row missing');
  const inquiry = (await pg.query('SELECT message, status FROM legacy_inquiries')).rows[0];
  assert(inquiry.status === 'received' && inquiry.message.startsWith('Cabinet refacing quote'), 'inquiry row wrong');
  const doc = (await pg.query('SELECT reference, items FROM legacy_owner_documents WHERE kind=\'quote\'')).rows[0];
  assert(doc.reference === 'Q-001', `reference ${doc.reference} !== Q-001`);
  const flat = doc.items.map(item => ({ description: item.description, qty: item.qty, unit_price: item.unit_price }));
  assert(JSON.stringify(flat) === JSON.stringify([{ description: 'Cabinet doors', qty: '12', unit_price: '85' }, { description: 'Install labor', qty: '4', unit_price: '65' }]), `items normalized oddly: ${JSON.stringify(doc.items)} (jsonb key order is PostgreSQL's canonical sort, values compared field-by-field)`);
  const lines = await brandedEvidence(bytes, { title: 'Cabinet refacing quote', reference: 'Q-001', due: null, total: '$1280.00' });
  await writeFile(path.join(outDir, 'quote-items.pdf'), bytes);
  results.push(['quote (with items)', 'evidence', 'PASS', lines.join(' | ')]);
});

await check('invoice (with items)', 'save → dedupe retry → approve → INV-001 + legacy_invoices row (128000 cents, Net 7) + branded PDF', async () => {
  const saved = await save({ kind: 'invoice', title: 'Cabinet invoice 1001', content: 'Cabinet refacing completed on site.', recipient: 'customer@example.com', items });
  assert(saved.status === 200 && /saved/.test(saved.body.response), `save failed: ${JSON.stringify(saved.body)}`);
  const dupe = await save({ kind: 'invoice', title: 'Cabinet invoice 1001', content: 'Cabinet refacing completed on site.', recipient: 'customer@example.com', items });
  assert(/already saved/.test(dupe.body.response), `identical retry did not dedupe: ${dupe.body.response}`);
  const beforeMail = mailLog.length;
  const bytes = await downloadPdf(beforeMail - 1, 'Cabinet invoice 1001', 'Cabinet refacing completed on site.');
  const row = (await pg.query('SELECT i.amount_cents, i.due_date::text AS due, i.status FROM legacy_invoices i JOIN legacy_owner_documents d ON d.id=i.document')).rows[0];
  assert(row.amount_cents === 128000, `registered amount ${row.amount_cents} !== 128000`);
  assert(row.due === dueToday, `due ${row.due} !== Net 7 of today (${dueToday})`);
  assert(row.status === 'open', `status ${row.status}`);
  const doc = (await pg.query('SELECT reference FROM legacy_owner_documents WHERE kind=\'invoice\' AND items IS NOT NULL')).rows[0];
  assert(doc.reference === 'INV-001', `reference ${doc.reference} !== INV-001`);
  assert(await count("SELECT count(*)::int AS n FROM legacy_invoice_events WHERE event='registered'") === 1, 'registered event count !== 1');
  const replay = await approveDraft(beforeMail - 1, 'Cabinet invoice 1001', 'Cabinet refacing completed on site.');
  assert(replay.status === 409, `replay approve ${replay.status} !== 409`);
  assert(await count('SELECT count(*)::int AS n FROM legacy_invoices') === 1, 'replay created a second invoice row');
  const lines = await brandedEvidence(bytes, { title: 'Cabinet invoice 1001', reference: 'INV-001', due: row.due, total: '$1280.00' });
  await writeFile(path.join(outDir, 'invoice-items.pdf'), bytes);
  results.push(['invoice (with items)', 'evidence', 'PASS', `${lines.join(' | ')} | row: ${row.amount_cents} cents, due ${row.due}, status ${row.status}`]);
});

await check('invoice (prose only)', 'save → approve → INV-002 issued, NO legacy_invoices row (no amount is fabricated), branded PDF still served', async () => {
  const saved = await save({ kind: 'invoice', title: 'Handyman invoice 1002', content: 'Labor and materials as discussed on the call.', recipient: 'customer@example.com' });
  assert(saved.status === 200, `save failed: ${JSON.stringify(saved.body)}`);
  const bytes = await downloadPdf(mailLog.length - 1, 'Handyman invoice 1002', 'Labor and materials as discussed on the call.');
  const doc = (await pg.query('SELECT reference FROM legacy_owner_documents WHERE title=\'Handyman invoice 1002\'')).rows[0];
  assert(doc.reference === 'INV-002', `reference ${doc.reference} !== INV-002`);
  assert(await count('SELECT count(*)::int AS n FROM legacy_invoices') === 1, 'a prose-only invoice fabricated a legacy_invoices row');
  const lines = await brandedEvidence(bytes, { title: 'Handyman invoice 1002', reference: 'INV-002', due: dueToday, total: null });
  await writeFile(path.join(outDir, 'invoice-prose.pdf'), bytes);
  results.push(['invoice (prose only)', 'evidence', 'PASS', `${lines.join(' | ')} | no items dictated, so the stationery draws no items table or totals block; chase skips this draft by design (no registered amount; the manual register path remains the way in)`]);
});

await check('field_report', 'save → approve → records-only (no new contact/inquiry/invoice), branded PDF without reference or due', async () => {
  const inquiriesBefore = await count('SELECT count(*)::int AS n FROM legacy_inquiries');
  const saved = await save({ kind: 'field_report', title: 'Walkthrough report', content: 'Inspected the property. No damage observed.', recipient: 'customer@example.com' });
  assert(saved.status === 200, `save failed: ${JSON.stringify(saved.body)}`);
  const bytes = await downloadPdf(mailLog.length - 1, 'Walkthrough report', 'Inspected the property. No damage observed.');
  const doc = (await pg.query('SELECT reference FROM legacy_owner_documents WHERE title=\'Walkthrough report\'')).rows[0];
  assert(doc.reference === null, `field_report got a reference: ${doc.reference}`);
  assert(await count('SELECT count(*)::int AS n FROM legacy_inquiries') === inquiriesBefore, 'field_report fabricated an inquiry');
  assert(await count('SELECT count(*)::int AS n FROM legacy_invoices') === 1, 'field_report fabricated an invoice');
  const lines = await brandedEvidence(bytes, { title: 'Walkthrough report', reference: '', due: null, total: null });
  await writeFile(path.join(outDir, 'field-report.pdf'), bytes);
  results.push(['field_report', 'evidence', 'PASS', lines.join(' | ')]);
});

await check('board_request', 'save → Board analysis stored on the draft → approval refused (owner-only)', async () => {
  const saved = await save({ kind: 'board_request', title: 'Diagnostic fee decision', content: 'Should I raise my diagnostic fee from $89 to $109?' });
  assert(saved.status === 200, `save failed: ${JSON.stringify(saved.body)}`);
  const link = documentLink(mailLog.length - 1);
  const boardForm = new FormData(); boardForm.set('action', 'board'); boardForm.set('version', '1');
  assert((await ownerReview(new Request(link, { method: 'POST', body: boardForm }))).status === 303, 'Board analysis failed');
  const row = (await pg.query('SELECT content, status FROM legacy_owner_documents WHERE title=\'Diagnostic fee decision\'')).rows[0];
  assert(/Board analysis:/.test(row.content) && row.status === 'draft', 'the memo was not stored on the draft');
  const refused = await ownerReview(new Request(link, { method: 'POST', body: approveForm('Diagnostic fee decision', 'Should I raise my diagnostic fee from $89 to $109?') }));
  assert(refused.status >= 400 && refused.status !== 303, `board approval was not refused: ${refused.status}`);
  assert((await count('SELECT count(*)::int AS n FROM legacy_inquiries')) === 1, 'board_request fabricated a record');
});

await check('dedupe', 'draft table holds exactly five documents (identical invoice retry deduped)', async () => {
  assert(await count('SELECT count(*)::int AS n FROM legacy_owner_documents') === 5, `draft count !== 5`);
});

await check('quote-photo', 'upload → price → send → exactly one more inquiry from the photo surface', async () => {
  const inquiriesBefore = await count('SELECT count(*)::int AS n FROM legacy_inquiries');
  const photo = Buffer.alloc(200, 7).toString('base64');
  const upload = await json(await quotes(new Request('https://legacyai.space/api/frontdesk/quote-photo', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-frontdesk-secret': env.QUOTE_SECRET }, body: JSON.stringify({ mime: 'image/png', data: photo, filename: 'dryrun.png', note: 'Water under the sink.' }) })));
  assert(upload.status === 200, `upload failed: ${JSON.stringify(upload.body)}`);
  const token = signOwnerToken({ id: upload.body.id, scope: 'quote-photo', exp: Date.now() + 86400000 }, env.RECEPTIONIST_SESSION_SECRET);
  const formPost = fields => quotes(new Request(`https://legacyai.space/api/frontdesk/quote-photo?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, ...fields }) }));
  assert((await formPost({ action: 'save', quote: 'Replace the trap and the supply line. Includes one visit.', price: '180.50' })).status === 200, 'pricing failed');
  assert(/Quote sent to customer@example\.com/.test(await (await formPost({ action: 'send', customer_email: 'customer@example.com' })).text()), 'the quote send failed');
  const inquiry = (await pg.query('SELECT message FROM legacy_inquiries ORDER BY created_at DESC LIMIT 1')).rows[0];
  assert(/Photo quote dryrun\.png: Replace the trap/.test(inquiry.message), `photo inquiry wrong: ${inquiry.message}`);
  assert(await count('SELECT count(*)::int AS n FROM legacy_inquiries') === inquiriesBefore + 1, 'the photo surface did not add exactly one inquiry');
});

await check('digest', 'forced digest surfaces the pending board draft and the open invoice', async () => {
  const before = mailLog.length;
  const result = await json(await assistant.digest(new Request('https://legacyai.space/api/owner/digest?force=1&slot=evening', { headers: { authorization: `Bearer ${env.CRON_SECRET}` } })));
  assert(result.body.sent === true, `digest did not send: ${JSON.stringify(result.body)}`);
  assert(mailLog.length === before + 1, 'digest sent more than one mail');
  const body = mailLog.at(-1).body;
  assert(body.includes('dictated draft awaiting your review: Diagnostic fee decision'), 'pending-draft note missing');
  assert(body.includes('open invoice soonest due'), 'open-invoice note missing');
});

const failed = results.filter(([, , verdict]) => verdict === 'FAIL');
console.log('\n=== structured-capture dry run ===');
console.log(`host: ${process.cwd()} | db: in-memory PGlite + migrations 0000-0002 | network: none (collector mailer)`);
console.log(`out: ${outDir}\n`);
for (const [kind, name, verdict, detail] of results) {
  console.log(`${verdict === 'PASS' ? 'PASS' : 'FAIL'}  ${kind.padEnd(18)} ${name}`);
  if (detail) console.log(`     ${detail}`);
}
console.log(`\n${results.filter(r => r[2] === 'PASS').length}/${results.length} checks passed${failed.length ? ` — FAILURES: ${failed.length}` : ' — every kind simulated save → approve → render → records'}`);
await pg.close();
process.exit(failed.length ? 1 : 0);
