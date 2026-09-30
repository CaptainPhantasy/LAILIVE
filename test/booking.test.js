import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSlots, readRules, parseICS, bookingICS, groupByDay, slotId } from '../dist/booking/core.js';

// Monday 2026-10-05 07:00 local time.
const now = new Date(2026, 9, 5, 7, 0);
const weekdays = { days: [1, 2, 3, 4, 5], open: '09:00', close: '12:00', length: 60, horizonDays: 7 };

test('slots fit inside open hours on chosen days only', () => {
  const slots = buildSlots(weekdays, [], now);
  assert.equal(slots.length, 15); // 3 per weekday, Monday through Friday.
  for (const s of slots) {
    assert(s.start.getDay() >= 1 && s.start.getDay() <= 5);
    assert(s.start.getHours() >= 9 && s.end.getHours() * 60 + s.end.getMinutes() <= 12 * 60);
  }
  assert.equal(groupByDay(slots).length, 5);
  assert.equal(slots[0].id, '20261005T0900');
});

test('buffer arithmetic is exact at the edges', () => {
  const busy = [{ start: new Date(2026, 9, 5, 10, 0), end: new Date(2026, 9, 5, 10, 30) }];
  const ids = buildSlots({ ...weekdays, buffer: 15, horizonDays: 1 }, busy, now).map(s => s.id);
  assert.deepEqual(ids, ['20261005T1100']);
  const tight = buildSlots({ ...weekdays, buffer: 30, horizonDays: 1 }, busy, now).map(s => s.id);
  assert.deepEqual(tight, ['20261005T1100']);
  const wide = buildSlots({ ...weekdays, buffer: 31, horizonDays: 1 }, busy, now).map(s => s.id);
  assert.deepEqual(wide, []);
  const later = buildSlots({ ...weekdays, noticeHours: 3, horizonDays: 1 }, [], now).map(s => s.id);
  assert.deepEqual(later, ['20261005T1000', '20261005T1100']);
});

test('invalid rules are refused with plain messages', () => {
  assert.throws(() => readRules({ ...weekdays, days: [] }), /at least one day/);
  assert.throws(() => readRules({ ...weekdays, close: '08:00' }), /after opening/);
  assert.throws(() => readRules({ ...weekdays, length: 500 }), /between 5 and 480/);
  assert.throws(() => readRules({ ...weekdays, open: '9am' }), /24-hour/);
});

test('iCalendar busy events block slots; free, cancelled and recurring are reported', () => {
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'DTSTART:20261005T093000', 'DTEND:20261005T101500', 'SUMMARY:Job\\, site visit', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261006', 'SUMMARY:Day off', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261007T090000', 'DURATION:PT2H', 'TRANSP:TRANSPARENT', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261008T090000', 'DTEND:20261008T100000', 'STATUS:CANCELLED', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261009T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:2026100', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const result = parseICS(ics);
  assert.equal(result.busy.length, 3);
  assert.equal(result.free, 2);
  assert.equal(result.recurring, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.busy[0].summary, 'Job, site visit');
  const ids = buildSlots(weekdays, result.busy, now).map(s => s.id);
  assert(!ids.includes('20261005T0900') && !ids.includes('20261005T1000') && ids.includes('20261005T1100'));
  assert(!ids.some(id => id.startsWith('20261006')), 'the all-day event blocks Tuesday');
  assert(ids.includes('20261007T0900') && ids.includes('20261008T0900') && !ids.includes('20261009T0900'));
});

test('UTC times, folded lines and non-calendars are handled', () => {
  const result = parseICS('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261005T140000Z\nDTEND:20261005T15\n 0000Z\nEND:VEVENT\nEND:VCALENDAR');
  assert.equal(result.busy[0].start.getTime(), Date.UTC(2026, 9, 5, 14));
  assert.equal(result.busy[0].end.getTime(), Date.UTC(2026, 9, 5, 15));
  assert.throws(() => parseICS('Name,Email'), /iCalendar/);
});

test('a booking round-trips through the calendar file it produces', () => {
  const start = new Date(2026, 9, 5, 9), end = new Date(2026, 9, 5, 10);
  const file = bookingICS({ start, end, title: 'Ann; leak, kitchen', uid: 'x@legacyai.space', stamp: new Date(0) });
  assert(file.includes(String.raw`SUMMARY:Ann\; leak\, kitchen`));
  assert(file.split('\r\n').every(line => line.length <= 75));
  const back = parseICS(file).busy[0];
  assert.equal(back.start.getTime(), start.getTime());
  assert.equal(back.end.getTime(), end.getTime());
  assert.equal(slotId(back.start), '20261005T0900');
  assert.throws(() => bookingICS({ start: end, end: start }));
});
