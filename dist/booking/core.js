// Pure scheduling operations shared by the booking calendar and the receptionist.
// All times are the visitor's local time; nothing here reads storage or the network.
export const LIMITS = Object.freeze({ icsBytes: 1024 * 1024, busy: 5000, horizonDays: 60, slots: 400 });
export const DAY_NAMES = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
const MINUTE = 60000;

export function parseClock(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim());
  if (!match) throw new Error('Use a 24-hour time such as 09:00 or 17:30.');
  return Number(match[1]) * 60 + Number(match[2]);
}

export function readRules(input) {
  const days = [...new Set((input.days || []).map(Number))].filter(day => Number.isInteger(day) && day >= 0 && day <= 6).sort();
  if (!days.length) throw new Error('Choose at least one day you take appointments.');
  const open = parseClock(input.open), close = parseClock(input.close);
  if (close <= open) throw new Error('Closing time must be after opening time.');
  const whole = (value, min, max, message) => { const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) throw new Error(message); return n; };
  const length = whole(input.length, 5, 480, 'Appointment length must be between 5 and 480 minutes.');
  if (length > close - open) throw new Error('The appointment is longer than your open hours.');
  return {
    days, open, close, length,
    buffer: whole(input.buffer ?? 0, 0, 240, 'Buffer must be between 0 and 240 minutes.'),
    step: whole(input.step ?? length, 5, 480, 'Start times must be 5 to 480 minutes apart.'),
    noticeHours: whole(input.noticeHours ?? 0, 0, 336, 'Minimum notice must be between 0 and 336 hours.'),
    horizonDays: whole(input.horizonDays ?? 14, 1, LIMITS.horizonDays, `Show between 1 and ${LIMITS.horizonDays} days ahead.`),
  };
}

const overlaps = (start, end, busy) => busy.some(b => start < b.end && end > b.start);

// Every returned slot fits inside open hours, respects notice, and keeps `buffer`
// minutes clear on both sides of every busy interval, so no double-booking is offered.
export function buildSlots(input, busy = [], now = new Date()) {
  const rules = readRules(input);
  const earliest = now.getTime() + rules.noticeHours * 60 * MINUTE;
  const padded = busy.map(b => ({ start: b.start.getTime() - rules.buffer * MINUTE, end: b.end.getTime() + rules.buffer * MINUTE }));
  const slots = [];
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let offset = 0; offset < rules.horizonDays && slots.length < LIMITS.slots; offset++) {
    const day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + offset);
    if (!rules.days.includes(day.getDay())) continue;
    for (let minute = rules.open; minute + rules.length <= rules.close && slots.length < LIMITS.slots; minute += rules.step) {
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minute);
      const end = new Date(start.getTime() + rules.length * MINUTE);
      if (start.getTime() < earliest || overlaps(start.getTime(), end.getTime(), padded)) continue;
      slots.push({ id: slotId(start), start, end });
    }
  }
  return slots;
}

const pad = n => String(n).padStart(2, '0');
export const slotId = date => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}`;

export function slotLabel(slot, locale = 'en-US') {
  const day = slot.start.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' });
  const time = value => value.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time(slot.start)}–${time(slot.end)}`;
}

export function groupByDay(slots) {
  const groups = new Map();
  for (const slot of slots) {
    const key = slotId(slot.start).slice(0, 8);
    if (!groups.has(key)) groups.set(key, { date: new Date(slot.start.getFullYear(), slot.start.getMonth(), slot.start.getDate()), slots: [] });
    groups.get(key).slots.push(slot);
  }
  return [...groups.values()];
}

// iCalendar reading: enough of RFC 5545 for exported busy times. Recurring rules
// are not expanded; they are counted so the page can say so plainly.
function unfold(text) { return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, ''); }

export function parseICSDate(raw, params = '') {
  const value = raw.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (m || /VALUE=DATE(?!-)/i.test(params)) {
    m = m || /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (!m) throw new Error('Unreadable calendar date.');
    return { date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), allDay: true };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) throw new Error('Unreadable calendar time.');
  const parts = m.slice(1, 7).map(Number);
  // UTC times are exact; floating and TZID times are read as the visitor's local time.
  const date = m[7] ? new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5])) : new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  return { date, allDay: false };
}

function parseDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, sign, w, d, h, min, s] = m;
  const ms = (((Number(w || 0) * 7 + Number(d || 0)) * 24 + Number(h || 0)) * 60 + Number(min || 0)) * MINUTE + Number(s || 0) * 1000;
  return sign === '-' ? -ms : ms;
}

export function parseICS(text) {
  if (typeof text !== 'string') throw new Error('Supply calendar text.');
  if (new TextEncoder().encode(text).length > LIMITS.icsBytes) throw new Error('Choose a calendar file no larger than 1 MB.');
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('This does not look like an iCalendar (.ics) file.');
  const busy = [];
  let event = null, recurring = 0, skipped = 0, free = 0;
  for (const line of unfold(text).split('\n')) {
    if (/^BEGIN:VEVENT$/i.test(line.trim())) { event = {}; continue; }
    if (/^END:VEVENT$/i.test(line.trim())) {
      if (event) {
        if (event.rrule) recurring++;
        if (event.transparent || event.cancelled) free++;
        else if (!event.start) skipped++;
        else {
          let end = event.end;
          if (!end && event.duration != null) end = new Date(event.start.date.getTime() + event.duration);
          if (!end) end = event.start.allDay ? new Date(event.start.date.getFullYear(), event.start.date.getMonth(), event.start.date.getDate() + 1) : event.start.date;
          if (end > event.start.date) busy.push({ start: event.start.date, end, summary: event.summary || '' });
          else skipped++;
          if (busy.length > LIMITS.busy) throw new Error(`Load up to ${LIMITS.busy.toLocaleString()} calendar events at a time.`);
        }
      }
      event = null; continue;
    }
    if (!event) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon), value = line.slice(colon + 1);
    const [name, ...params] = head.split(';');
    const key = name.toUpperCase(), paramText = params.join(';');
    try {
      if (key === 'DTSTART') event.start = parseICSDate(value, paramText);
      else if (key === 'DTEND') event.end = parseICSDate(value, paramText).date;
      else if (key === 'DURATION') event.duration = parseDuration(value);
      else if (key === 'RRULE') event.rrule = true;
      else if (key === 'TRANSP') event.transparent = /TRANSPARENT/i.test(value);
      else if (key === 'STATUS') event.cancelled = /CANCELLED/i.test(value);
      else if (key === 'SUMMARY') event.summary = value.replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ').slice(0, 200);
    } catch { event.start = null; }
  }
  busy.sort((a, b) => a.start - b.start);
  return { busy, recurring, skipped, free };
}

const icsText = value => String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsUTC = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function fold(line) {
  const out = [];
  for (let i = 0; i < line.length; i += 73) out.push((i ? ' ' : '') + line.slice(i, i + 73));
  return out.join('\r\n');
}

export function bookingICS({ start, end, title, description = '', uid, stamp = new Date() }) {
  if (!(start instanceof Date) || !(end instanceof Date) || end <= start) throw new Error('Choose an open time first.');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Legacy AI Solutions//Booking calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${uid || `${slotId(start)}-${Math.random().toString(36).slice(2)}@legacyai.space`}`, `DTSTAMP:${icsUTC(stamp)}`, `DTSTART:${icsUTC(start)}`, `DTEND:${icsUTC(end)}`,
    `SUMMARY:${icsText(title || 'Appointment')}`, ...(description ? [`DESCRIPTION:${icsText(description)}`] : []), 'END:VEVENT', 'END:VCALENDAR'];
  return lines.map(fold).join('\r\n') + '\r\n';
}
