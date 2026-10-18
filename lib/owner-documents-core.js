import { createHmac, timingSafeEqual, scryptSync } from 'node:crypto';
export function signOwnerToken(payload, secret) {
  if (!secret || secret.length < 24) throw new Error('Owner session secret is not configured.');
  const value = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${value}.${createHmac('sha256', secret).update(value).digest('base64url')}`;
}
export function readOwnerToken(token, secret, now = Date.now()) {
  try {
    const [value, signature, extra] = String(token).split('.');
    if (extra || !secret || !signature) return null;
    const expected = createHmac('sha256', secret).update(value).digest('base64url');
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(value, 'base64url').toString());
    return data.exp > now ? data : null;
  } catch { return null; }
}
// A prompt that enables speech turns keypad presses into words, so a PIN can arrive
// as "zero five two eight..." rather than digits. Both forms are accepted; whichever
// form produced more characters is the one used, so a mixed entry cannot interleave.
const DIGIT_WORDS = new Map([
  ['zero', 0], ['oh', 0], ['cero', 0],
  ['one', 1], ['uno', 1], ['una', 1],
  ['two', 2], ['to', 2], ['too', 2], ['dos', 2],
  ['three', 3], ['tres', 3],
  ['four', 4], ['for', 4], ['cuatro', 4],
  ['five', 5], ['cinco', 5],
  ['six', 6], ['seis', 6],
  ['seven', 7], ['siete', 7],
  ['eight', 8], ['ate', 8], ['ocho', 8],
  ['nine', 9], ['nueve', 9],
]);
export function pinDigits(value) {
  const text = String(value ?? '').toLowerCase();
  const digits = text.replace(/\D/g, '');
  const spoken = text.split(/[^a-z0-9]+/).map(token => DIGIT_WORDS.has(token) ? String(DIGIT_WORDS.get(token)) : '').join('');
  return (digits.length >= spoken.length ? digits : spoken).slice(0, 12);
}
export function verifyOwnerPin(pin, encoded) {
  if (!/^[0-9]{6,12}$/.test(String(pin))) return false;
  const [salt, hash] = String(encoded || '').split(':');
  if (!/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{64}$/.test(hash || '')) return false;
  // A stored hash is exactly 32 bytes, so a well-formed encoding always produces a
  // comparable buffer and a malformed one has already failed the length checks above.
  const actual = scryptSync(String(pin), salt, 32);
  return actual.length === 32 && timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}
// Built-in PDF font supports Latin-1; reject unsupported glyphs rather than silently
// replacing customer names. All supplied text remains editable in the approval view.
export function documentPdf(title, content) {
  const text = `${title}\nLegacy AI LLC\n\n${content}`;
  if (/[^\x09\x0a\x0d\x20-\xff]/.test(text)) throw new Error('PDF text contains unsupported characters; edit the draft before downloading.');
  const lines = text.split(/\r?\n/).flatMap(line => line.match(/.{1,85}(?:\s|$)|.{1,85}/g) || ['']);
  const pages = [];
  for (let i = 0; i < lines.length; i += 48) pages.push(lines.slice(i, i + 48));
  const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'];
  const pageIds = [];
  for (const page of pages) {
    const pageId = objects.length + 1, streamId = pageId + 1; pageIds.push(pageId);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`);
    const escape = x => x.replace(/([\\()])/g, '\\$1');
    const stream = `BT /F1 10 Tf 14 TL 40 750 Td ${page.map((line, index) => `${index ? 'T* ' : ''}(${escape(line)}) Tj`).join('\n')} ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  let result = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(result, 'latin1')); result += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const start = Buffer.byteLength(result, 'latin1');
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(x => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(result, 'latin1');
}
