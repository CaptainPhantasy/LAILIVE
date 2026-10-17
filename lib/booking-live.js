import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { frontdeskSecret } from './frontdesk.js';
import { secretMatches } from './assistant.js';
import { createBookingCalendarProvider } from './booking-live-provider.js';

export const BOOKING_ZONE = 'America/Indianapolis';
const MINUTE = 60000, DAY = 86400000, DURATION = 60 * MINUTE, BUFFER = 30 * MINUTE;
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const hash = value => createHash('sha256').update(value).digest('hex');
const clean = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';
const unavailable = (reason = 'Calendar booking is temporarily unavailable. Take a request for Douglas; no appointment is confirmed.') => ({ available: false, booked: false, reason });
const parts = timestamp => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: BOOKING_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(timestamp).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
const localDate = timestamp => { const p = parts(timestamp); return `${p.year}-${p.month}-${p.day}`; };
function localNoon(day) {
  let timestamp = Date.parse(`${day}T12:00:00Z`);
  const p = parts(timestamp);
  timestamp += (12 - Number(p.hour)) * 60 * MINUTE;
  return timestamp;
}
function validStart(value, now) {
  const timestamp = typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp) || timestamp <= now || timestamp > now + 30 * DAY) return null;
  const p = parts(timestamp);
  if (['Sat', 'Sun'].includes(p.weekday) || Number(p.hour) < 12 || Number(p.hour) > 15 || !['00', '30'].includes(p.minute) || Number(p.second) || timestamp % 1000 || (Number(p.hour) === 15 && p.minute !== '00')) return null;
  return timestamp;
}
const clashes = (start, end, busy) => busy.some(period => start < Date.parse(period.end) + BUFFER && end + BUFFER > Date.parse(period.start));
const label = start => new Date(start).toLocaleString('en-US', { timeZone: BOOKING_ZONE, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function createLiveBooking({ getDb, env = process.env, provider = createBookingCalendarProvider({ env }), now = Date.now } = {}) {
  let ready;
  const ensure = () => ready ||= (async () => {
    const db = getDb();
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_booking_locks (calendar_id text PRIMARY KEY)`));
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_live_bookings (request_id text PRIMARY KEY, calendar_id text NOT NULL, event_id text NOT NULL, fingerprint text NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(calendar_id,event_id))`));
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_booking_limits (bucket text PRIMARY KEY, count integer NOT NULL DEFAULT 0)`));
    for (const table of ['legacy_booking_locks', 'legacy_live_bookings', 'legacy_booking_limits']) await db.execute(sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
  })().catch(error => { ready = null; throw error; });
  // Once confirmed, Google Calendar is authoritative: a manual cancellation or
  // reschedule must free the original slot. Only unresolved writes need a local
  // hold in addition to the fresh provider free/busy check.
  const active = async (db = getDb()) => (await db.execute(sql`SELECT starts_at, ends_at FROM legacy_live_bookings WHERE calendar_id=${provider.calendarId} AND status IN ('pending','uncertain') AND ends_at > ${new Date(now() - DAY).toISOString()}::timestamptz`)).rows.map(row => ({ start: new Date(row.starts_at).toISOString(), end: new Date(row.ends_at).toISOString() }));
  const rate = async callId => {
    await ensure();
    const key = hash(`${callId}:${localDate(now())}`);
    const result = await getDb().execute(sql`INSERT INTO legacy_booking_limits(bucket,count) VALUES (${key},1) ON CONFLICT(bucket) DO UPDATE SET count=legacy_booking_limits.count+1 WHERE legacy_booking_limits.count < 60 RETURNING count`);
    return result.rows.length > 0;
  };
  const eventMatches = (event, expected) => event?.kind === 'calendar#event' && event.id === expected.id && event.status === 'confirmed'
    && Date.parse(event.start?.dateTime) === Date.parse(expected.start.dateTime) && Date.parse(event.end?.dateTime) === Date.parse(expected.end.dateTime)
    && event.attendees?.some(person => person.email?.toLowerCase() === expected.attendees[0].email)
    && event.extendedProperties?.private?.legacyBooking === expected.extendedProperties.private.legacyBooking;
  async function mark(requestId, status) { await getDb().execute(sql`UPDATE legacy_live_bookings SET status=${status},updated_at=now() WHERE request_id=${requestId}`); }
  function receipt(event, start, replay = false) {
    return { booked: true, eventId: event.id, start: new Date(start).toISOString(), end: new Date(start + DURATION).toISOString(), timeZone: BOOKING_ZONE, label: label(start), invitationRequested: true, invitationDelivered: null, replay,
      response: `The appointment is reserved for ${label(start)}, Indiana time, for one hour. Google Calendar was asked to invite the confirmed email address. Inbox delivery and acceptance have not been verified.` };
  }
  return {
    configured: provider.configured,
    async availability({ fromDate, days = 7 } = {}) {
      const deadline = Date.now() + 45000;
      if (!provider.configured) return unavailable();
      const first = fromDate || localDate(now());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || !Number.isFinite(Date.parse(first)) || localDate(localNoon(first)) !== first || first < localDate(now()) || localNoon(first) > now() + 23 * DAY) return unavailable('Choose a date within the next 23 days.');
      const count = Number.isInteger(days) ? Math.min(7, Math.max(1, days)) : 7;
      try {
        await ensure();
        const start = localNoon(first), finish = start + count * DAY;
        const periods = await provider.busy(new Date(start - BUFFER).toISOString(), new Date(finish + BUFFER).toISOString(), { deadline });
        const busy = [...periods, ...await active()];
        const slots = [];
        for (let day = 0; day < count; day++) {
          const noon = localNoon(new Date(Date.parse(`${first}T12:00:00Z`) + day * DAY).toISOString().slice(0, 10));
          for (let offset = 0; offset <= 180; offset += 30) {
            const timestamp = noon + offset * MINUTE;
            if (!validStart(new Date(timestamp).toISOString(), now()) || clashes(timestamp, timestamp + DURATION, busy)) continue;
            slots.push({ start: new Date(timestamp).toISOString(), end: new Date(timestamp + DURATION).toISOString(), label: label(timestamp) });
          }
        }
        return { available: true, booked: false, timeZone: BOOKING_ZONE, durationMinutes: 60, bufferMinutes: 30, slots, response: slots.length ? 'Offer only these available slots. A slot is not reserved until book_appointment succeeds.' : 'There are no available slots in this period. Check another date or take a request for Douglas.' };
      } catch { return unavailable(); }
    },
    async reserve({ slotStart, name, email, phone, requestId, approved } = {}) {
      const deadline = Date.now() + 45000;
      if (!provider.configured) return unavailable();
      const start = validStart(slotStart, now()), customerName = clean(name, 120), customerEmail = clean(email, 254).toLowerCase(), callback = clean(phone, 40);
      if (!start || !customerName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) || approved !== true || !/^[A-Za-z0-9_:.\-]{1,180}$/.test(requestId || '')) return unavailable('A valid available time, name, email, call identity and explicit booking approval are required. No appointment was reserved.');
      const end = start + DURATION, fingerprint = hash(JSON.stringify({ start, customerName, customerEmail, callback }));
      const id = hash(`${provider.calendarId}:${requestId}`);
      const event = { id, summary: `Legacy AI consultation — ${customerName}`, description: `Appointment booked with Darla.\nName: ${customerName}${callback ? `\nCallback: ${callback}` : ''}`, start: { dateTime: new Date(start).toISOString(), timeZone: BOOKING_ZONE }, end: { dateTime: new Date(end).toISOString(), timeZone: BOOKING_ZONE }, attendees: [{ email: customerEmail, displayName: customerName, responseStatus: 'needsAction' }], guestsCanInviteOthers: false, guestsCanSeeOtherGuests: false, extendedProperties: { private: { legacyBooking: fingerprint } } };
      let claim, insertStarted = false;
      try {
        await ensure();
        // The transaction serializes new claims for this calendar. Its durable
        // pending row then excludes the slot throughout the external API call,
        // including process termination and ambiguous provider responses.
        claim = await getDb().transaction(async tx => {
          await tx.execute(sql`INSERT INTO legacy_booking_locks(calendar_id) VALUES (${provider.calendarId}) ON CONFLICT DO NOTHING`);
          await tx.execute(sql`SELECT calendar_id FROM legacy_booking_locks WHERE calendar_id=${provider.calendarId} FOR UPDATE`);
          const prior = (await tx.execute(sql`SELECT * FROM legacy_live_bookings WHERE request_id=${requestId}`)).rows[0];
          if (prior && (prior.fingerprint !== fingerprint || prior.calendar_id !== provider.calendarId)) return { prior };
          if (prior?.status === 'conflict') {
            // A conflict verdict is retryable; release the row so the slot frees
            // when the calendar does, then run the attempt from scratch.
            await tx.execute(sql`DELETE FROM legacy_live_bookings WHERE request_id=${requestId}`);
          } else if (prior) return { prior };
          if (clashes(start, end, await active(tx))) return { conflict: true };
          await tx.execute(sql`INSERT INTO legacy_live_bookings(request_id,calendar_id,event_id,fingerprint,starts_at,ends_at,status) VALUES (${requestId},${provider.calendarId},${id},${fingerprint},${event.start.dateTime}::timestamptz,${event.end.dateTime}::timestamptz,'pending')`);
          return { created: true };
        });
        if (claim.conflict) return unavailable('That time is no longer available. Check availability again.');
        if (claim.prior) {
          if (claim.prior.fingerprint !== fingerprint || claim.prior.calendar_id !== provider.calendarId) return unavailable('This booking request already has different details. Do not change or duplicate it; check the original request.');
          // Reconcile only. Never blindly retry an uncertain event insertion.
          const existing = await provider.get(id, { deadline });
          if (!eventMatches(existing, event)) return unavailable('The previous booking could not be verified. Do not promise or create another appointment for this request.');
          await mark(requestId, 'confirmed');
          return receipt(existing, start, true);
        }
        // Check again immediately before writing, so manual Calendar changes
        // made since the offered availability are respected.
        const busy = await provider.busy(new Date(start - BUFFER).toISOString(), new Date(end + BUFFER).toISOString(), { deadline });
        if (clashes(start, end, busy)) { await mark(requestId, 'conflict'); return unavailable('That time is no longer available. Check availability again.'); }
        insertStarted = true;
        const inserted = await provider.insert(event, { deadline });
        if (!eventMatches(inserted, event)) throw new Error('Calendar receipt mismatch.');
        await mark(requestId, 'confirmed');
        return receipt(inserted, start);
      } catch {
        if (claim?.created && !insertStarted) {
          // Nothing reached the provider; release the hold so the slot is retryable.
          try { await getDb().execute(sql`DELETE FROM legacy_live_bookings WHERE request_id=${requestId}`); } catch { /* the pending hold survives for reconciliation */ }
        } else if (claim?.created) { try { await mark(requestId, 'uncertain'); } catch { /* pending remains an active durable hold */ } }
        return { ...unavailable('The booking outcome could not be verified. Do not promise a reservation or create a second booking; Douglas must check this request.'), uncertain: Boolean(claim?.prior || (claim?.created && insertStarted)) };
      }
    },
    rate,
  };
}

export function createLiveBookingHandler({ getDb, env = process.env, provider, now = Date.now, booking = createLiveBooking({ getDb, env, provider, now }) } = {}) {
  return async request => {
    try {
      if (request.method !== 'POST') return json({ error: 'POST required.' }, 405);
      if (!frontdeskSecret(request).some(value => secretMatches(value, env.RECEPTIONIST_WEBHOOK_SECRET))) return json({ error: 'Not authorized.' }, 401);
      if (Number(request.headers.get('content-length') || 0) > 16000) return json({ error: 'Too large.' }, 413);
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 16000) return json({ error: 'Too large.' }, 413);
      const input = JSON.parse(raw), callId = clean(input.call_id || input.call?.call_id, 120);
      if (!/^[A-Za-z0-9_:.\-]{1,120}$/.test(callId)) return json({ response: 'A verified call identifier is required. No appointment was reserved.' }, 400);
      if (!['check_availability', 'book_appointment'].includes(input.function)) return json({ response: 'Unknown booking function.' }, 400);
      if (!booking.configured) return json({ response: JSON.stringify(unavailable()) });
      if (!await booking.rate(callId)) return json({ response: 'Too many booking requests on this call. No additional booking was attempted.' }, 429);
      const args = Array.isArray(input.argument?.parsed) ? input.argument.parsed[0] : input.argument?.parsed;
      if (!args || typeof args !== 'object' || Array.isArray(args)) return json({ response: 'Valid booking arguments are required.' }, 400);
      const result = input.function === 'check_availability' ? await booking.availability({ fromDate: args.fromDate })
        : await booking.reserve({ ...args, requestId: `${callId}:${hash(String(args.slotStart || '')).slice(0, 16)}` });
      return json({ response: JSON.stringify(result) });
    } catch { return json({ response: 'The booking action could not be verified. No reservation is confirmed.' }, 503); }
  };
}
