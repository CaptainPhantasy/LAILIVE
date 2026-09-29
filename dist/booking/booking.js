import { DAY_NAMES, LIMITS, buildSlots, groupByDay, slotLabel, parseICS, bookingICS } from './core.js';

const $ = id => document.getElementById(id);
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
let imported = [], bookings = [], chosen = null, receipt = null;

for (const [index, name] of DAY_NAMES.entries()) {
  const label = node('label'), box = document.createElement('input');
  box.type = 'checkbox'; box.name = 'day'; box.value = String(index); box.checked = index >= 1 && index <= 5;
  label.append(box, name.slice(0, 3)); label.title = name; $('days').append(label);
}
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function rules() {
  return { days: [...document.querySelectorAll('input[name=day]:checked')].map(b => Number(b.value)), open: $('open').value, close: $('close').value, length: Number($('length').value), buffer: Number($('buffer').value), noticeHours: Number($('notice').value), horizonDays: Number($('horizon').value) };
}

function render() {
  error(); const container = $('slots'); container.replaceChildren();
  let slots;
  try { slots = buildSlots(rules(), [...imported, ...bookings], new Date()); }
  catch (e) { error(e.message); $('slot-count').textContent = 'Adjust your hours to see open times.'; return; }
  const groups = groupByDay(slots);
  $('slot-count').textContent = slots.length ? `${slots.length} open ${slots.length === 1 ? 'time' : 'times'} across ${groups.length} ${groups.length === 1 ? 'day' : 'days'}${slots.length >= LIMITS.slots ? ' (showing the first ' + LIMITS.slots + ')' : ''}. Choose one to book it as a customer would.` : 'No open times fit these settings. Try more days, longer hours or less notice.';
  for (const group of groups) {
    const day = node('section', undefined, 'tl-day'), list = node('ul'), id = `day-${group.slots[0].id.slice(0, 8)}`;
    const heading = node('h3', group.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })); heading.id = id;
    day.setAttribute('aria-labelledby', id);
    for (const slot of group.slots) {
      const item = node('li'), button = node('button', slot.start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }), 'tl-slot');
      button.type = 'button'; button.setAttribute('aria-pressed', String(chosen?.id === slot.id));
      button.addEventListener('click', () => choose(slot));
      item.append(button); list.append(item);
    }
    day.append(heading, list); container.append(day);
  }
  if (chosen && !slots.some(s => s.id === chosen.id)) { chosen = null; $('book').hidden = true; }
}

function choose(slot) {
  chosen = slot; $('book').hidden = false; $('book-time').textContent = slotLabel(slot, undefined);
  document.querySelectorAll('.tl-slot').forEach(b => b.setAttribute('aria-pressed', 'false'));
  render(); $('book-heading').focus();
}
$('cancel-book').addEventListener('click', () => { chosen = null; $('book').hidden = true; render(); });
$('book-form').addEventListener('submit', event => {
  event.preventDefault(); if (!chosen) return;
  const name = $('customer').value.trim(); if (!name) return;
  bookings.push({ start: chosen.start, end: chosen.end, summary: `${name}${$('purpose').value.trim() ? ' — ' + $('purpose').value.trim() : ''}` });
  $('customer').value = ''; $('purpose').value = ''; chosen = null; $('book').hidden = true; renderBookings(); render();
  $('slot-count').textContent = `Booked. That time and its buffer are no longer offered. ${$('slot-count').textContent}`;
});
function renderBookings() {
  $('booked').hidden = !bookings.length; const list = $('booked-list'); list.replaceChildren();
  for (const b of bookings) list.append(node('li', `${slotLabel(b, undefined)} · ${b.summary}`));
}
$('reset-bookings').addEventListener('click', () => { bookings = []; renderBookings(); render(); });
$('download-ics').addEventListener('click', () => {
  if (!bookings.length) return;
  // One calendar file holding every booking made in this session.
  const events = bookings.map(b => bookingICS({ start: b.start, end: b.end, title: b.summary, description: 'Test booking from the Legacy AI booking calendar preview.' }).split('\r\n'));
  const body = events.flatMap(lines => lines.slice(lines.indexOf('BEGIN:VEVENT'), lines.indexOf('END:VEVENT') + 1));
  const text = [...events[0].slice(0, events[0].indexOf('BEGIN:VEVENT')), ...body, 'END:VCALENDAR', ''].join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' })), link = node('a');
  link.href = url; link.download = 'legacy-ai-bookings.ics'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('ics-file').addEventListener('change', async () => {
  const file = $('ics-file').files[0]; if (!file) return;
  error();
  try {
    if (file.size > LIMITS.icsBytes) throw new Error('Choose a calendar file no larger than 1 MB.');
    const result = parseICS(await file.text());
    imported = result.busy;
    const notes = [`${result.busy.length} busy ${result.busy.length === 1 ? 'event' : 'events'} blocked out`];
    if (result.free) notes.push(`${result.free} free or cancelled ignored`);
    if (result.recurring) notes.push(`${result.recurring} repeating ${result.recurring === 1 ? 'event is' : 'events are'} blocked only on ${result.recurring === 1 ? 'its' : 'their'} first date — a live connection expands repeats`);
    if (result.skipped) notes.push(`${result.skipped} unreadable skipped`);
    $('ics-summary').textContent = `${notes.join('; ')}. Read on this device only.`; $('clear-ics').hidden = false;
    render();
  } catch (e) { imported = []; $('ics-summary').textContent = ''; $('ics-file').value = ''; render(); error(e.message); }
});
$('clear-ics').addEventListener('click', () => { imported = []; $('ics-file').value = ''; $('ics-summary').textContent = 'Calendar removed from this page.'; $('clear-ics').hidden = true; render(); });
for (const id of ['open', 'close', 'length', 'buffer', 'notice', 'horizon']) $(id).addEventListener('change', render);
$('days').addEventListener('change', render);

// Optional: the calendar works without this; the inquiry only opens a conversation.
$('discuss').addEventListener('click', async () => {
  try {
    const { requestLead } = await import('../lead-gate.js');
    receipt = receipt || await requestLead({ key: 'booking-calendar', purpose: 'Live booking calendar inquiry', serviceIds: ['the-live-booking-calendar'], title: 'Connect your real calendar.', intro: 'Tell Douglas which calendar you use today and how customers book now.', request: '', localNote: 'Only these contact details and your request are sent to Douglas. Your hours, calendar file and test bookings stay on this device.' });
    $('discuss-status').textContent = receipt ? `Inquiry received (${receipt.id}). Douglas can reply by email.` : '';
  } catch (e) { $('discuss-status').textContent = e.message; }
});
render();
