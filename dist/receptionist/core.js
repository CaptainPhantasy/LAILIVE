// Pure receptionist test-line helpers: profile shaping and the call record.
import { buildSlots, slotLabel } from '../booking/core.js';

export const MAX_SLOTS = 24;

export function parseServices(text) {
  const services = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*•]\s*/, '');
    if (!line) continue;
    const match = /^(.*?)\s*(?:\s[—–-]\s|:|\t|\|)\s*(.+)$/.exec(line) || /^(.*?)\s+(\$\s?\d[\d,.]*(?:\s*(?:\+|and up|\/\s?\w+|per \w+))?)$/i.exec(line);
    const name = (match ? match[1] : line).trim().slice(0, 100), price = (match ? match[2] : '').trim().slice(0, 80);
    if (name) services.push({ name, price });
    if (services.length > 15) throw new Error('List up to 15 services.');
  }
  return services;
}

export function buildProfile(fields) {
  const clean = (value, max) => String(value || '').trim().slice(0, max);
  const profile = {
    business: clean(fields.business, 80), trade: clean(fields.trade, 160), hours: clean(fields.hours, 400), area: clean(fields.area, 300),
    services: parseServices(fields.services), notes: clean(fields.notes, 1500),
    languages: ['en', 'es'].filter(code => fields.languages?.includes(code)),
  };
  if (!profile.business) throw new Error('Add your business name.');
  if (!profile.hours) throw new Error('Add your business hours so the receptionist can answer “are you open?”');
  if (!profile.languages.length) throw new Error('Choose at least one language.');
  return profile;
}

export function offeredSlots(rules, now = new Date(), locale = 'en-US') {
  return buildSlots(rules, [], now).slice(0, MAX_SLOTS).map(slot => ({ id: slot.id, label: slotLabel(slot, locale) }));
}

export function callRecord({ profile, slots, messages, turn, startedAt, endedAt }) {
  const held = turn?.booking?.slotId ? slots.find(slot => slot.id === turn.booking.slotId) : null;
  const lines = [
    `TEST CALL RECORD — ${profile.business}`,
    'Placed on the Legacy AI receptionist test line. Nothing was booked, texted or emailed.',
    `Started: ${startedAt ? new Date(startedAt).toLocaleString() : 'Unknown'}`,
    ...(endedAt ? [`Ended: ${new Date(endedAt).toLocaleString()}`] : []),
    '', 'What the owner would see',
    `Caller: ${turn?.caller?.name || 'Not given'}`,
    `Callback number: ${turn?.caller?.callback || 'Not given'}`,
    `Reason: ${turn?.caller?.reason || 'Not captured'}`,
    `Appointment: ${held ? `${held.label} (${turn.booking.status === 'held' ? 'held for you to confirm' : 'offered, not accepted'})` : 'None'}`,
    `Follow-up: ${turn?.followUp || 'None noted'}`,
    '', 'Transcript',
    ...messages.map(m => `${m.role === 'caller' ? 'Caller' : 'Receptionist'}: ${m.content}`),
  ];
  return lines.join('\n') + '\n';
}
