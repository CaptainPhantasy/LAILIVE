// Pure text-back operations. Nothing is sent from this page; carriers and SMS
// providers apply their own rules, so these checks are guidance, not approval.
const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€\f';
const basic = new Set(GSM_BASIC), extended = new Set(GSM_EXTENDED);
export const SHORTENERS = ['bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 't.co', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at'];

export function smsSegments(text) {
  const value = String(text ?? '');
  let septets = 0, gsm = true;
  for (const ch of value) {
    if (basic.has(ch)) septets += 1;
    else if (extended.has(ch)) septets += 2;
    else { gsm = false; break; }
  }
  if (gsm) {
    const segments = septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153);
    return { encoding: 'GSM-7', units: septets, segments, perSegment: segments > 1 ? 153 : 160 };
  }
  const units = value.length; // UTF-16 code units, as carriers count UCS-2.
  const segments = units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67);
  return { encoding: 'UCS-2', units, segments, perSegment: segments > 1 ? 67 : 70 };
}

// Characters that silently force the costlier UCS-2 encoding, with GSM-safe swaps.
const SWAPS = new Map([['‘', "'"], ['’', "'"], ['“', '"'], ['”', '"'], ['–', '-'], ['—', '-'], ['…', '...'], ['\u00a0', ' ']]);
export function gsmSafe(text) { return [...String(text ?? '')].map(ch => SWAPS.get(ch) ?? ch).join(''); }
export function nonGsmCharacters(text) { return [...new Set([...String(text ?? '')].filter(ch => !basic.has(ch) && !extended.has(ch)))]; }

export function render(template, fields) {
  return String(template).replace(/\{(business|link|callback|hours)\}/g, (_, key) => String(fields[key] ?? '').trim()).replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1').trim();
}

export function checkMessage(text, { business = '', first = false, spanish = false } = {}) {
  const warnings = [], value = String(text ?? '');
  if (!value.trim()) return [{ code: 'empty', message: 'Write a message.' }];
  const stats = smsSegments(value);
  if (business.trim() && !value.toLowerCase().includes(business.trim().toLowerCase())) warnings.push({ code: 'identify', message: 'Name your business so the caller knows who is texting.' });
  if (first && !(spanish ? /\b(STOP|ALTO)\b/.test(value) : /\bSTOP\b/.test(value))) warnings.push({ code: 'opt_out', message: spanish ? 'Tell people how to opt out, for example “Responda STOP para cancelar.”' : 'Tell people how to opt out, for example “Reply STOP to opt out.”' });
  const lower = value.toLowerCase();
  const shortener = SHORTENERS.find(domain => new RegExp(`(^|[^a-z0-9.-])${domain.replace(/\./g, '\\.')}(/|\\b)`).test(lower));
  if (shortener) warnings.push({ code: 'shortener', message: `Public link shorteners such as ${shortener} are often filtered by carriers. Use your own domain.` });
  const allowed = stats.encoding === 'UCS-2' ? 3 : 2; // Accented text bills at 70 characters per segment.
  if (stats.segments > allowed) warnings.push({ code: 'length', message: `This sends as ${stats.segments} billed segments. Aim for ${allowed === 3 ? 'three or fewer' : 'one or two'}.` });
  if (stats.encoding === 'UCS-2') {
    const fixable = nonGsmCharacters(value).filter(ch => SWAPS.has(ch));
    if (fixable.length) warnings.push({ code: 'encoding', message: `Curly quotes or long dashes (${fixable.join(' ')}) cut each segment from 160 to 70 characters. Use the plain-text fix.` });
  }
  const letters = value.replace(/[^A-Za-z]/g, '');
  const caps = value.replace(/\b(STOP|ALTO|HELP|OK|SMS|AM|PM)\b/g, '').replace(/[^A-Z]/g, '').length;
  if (letters.length >= 20 && caps / letters.length > 0.5) warnings.push({ code: 'caps', message: 'Mostly capital letters reads as shouting and can look like spam.' });
  return warnings;
}

export function buildTextBacks(input) {
  const business = String(input.business || '').trim();
  if (!business) throw new Error('Add your business name.');
  if (business.length > 60) throw new Error('Keep the business name under 60 characters.');
  const link = String(input.link || '').trim();
  if (link && !/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(link)) throw new Error('Use a web address such as example.com/book, or leave it blank.');
  const fields = { business, link, callback: String(input.callback || '').trim(), hours: String(input.hours || '').trim() };
  const booking = link ? ' Or book online: {link}' : '';
  const reservas = link ? ' O reserve aquí: {link}' : '';
  const english = [
    { key: 'open', label: 'Missed call · during business hours', first: true, template: `Hi, this is {business}. Sorry we missed your call! What can we help with? Reply here and we'll get right back to you.${booking} Reply STOP to opt out.` },
    { key: 'closed', label: 'Missed call · after hours', first: true, template: `Hi, this is {business}. We're closed right now${fields.hours ? ' (hours: {hours})' : ''}, but we got your call. Text us what you need and we'll reply ${fields.callback || 'first thing when we open'}.${booking} Reply STOP to opt out.` },
    { key: 'nudge', label: 'No reply · gentle follow-up', first: false, template: `Just checking in from {business}. Still need a hand? Reply with a good time and we'll call you.` },
  ];
  const spanish = [
    { key: 'open-es', label: 'Llamada perdida · en horario', first: true, spanish: true, template: `Hola, le escribe {business}. Perdón por no contestar. ¿En qué le ayudamos? Responda aquí.${reservas} Responda STOP para cancelar.` },
    { key: 'closed-es', label: 'Llamada perdida · fuera de horario', first: true, spanish: true, template: `Hola, le escribe {business}. Estamos cerrados${fields.hours ? ' (horario: {hours})' : ''}, pero recibimos su llamada. Díganos qué necesita y le respondemos al abrir.${reservas} Responda STOP para cancelar.` },
  ];
  return [...english, ...(input.spanish ? spanish : [])].map(item => ({ ...item, text: render(item.template, fields) }));
}
