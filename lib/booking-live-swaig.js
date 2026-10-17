export function bookingSwaigFunctions({ origin = 'https://legacyai.space', webhookSecret }) {
  if (!webhookSecret) throw new Error('Booking webhook secret is required.');
  const url = new URL('/api/frontdesk/booking', origin);
  if (url.protocol !== 'https:') throw new Error('Booking requires HTTPS.');
  url.username = 'frontdesk'; url.password = encodeURIComponent(webhookSecret);
  return [
    { function: 'check_availability', description: 'Look up actual available one-hour appointments with Douglas, Monday–Friday, noon–4pm Indiana time. Return only the slots this function supplies.', web_hook_url: url.href,
      parameters: { type: 'object', additionalProperties: false, properties: { fromDate: { type: 'string', description: 'First local date to check, YYYY-MM-DD; omit for today.' } } } },
    { function: 'book_appointment', description: 'After reading back the chosen time, name and email and receiving explicit approval, reserve the actual appointment and request a Google Calendar invitation. Confirm only if booked=true is returned.', web_hook_url: url.href,
      parameters: { type: 'object', additionalProperties: false, properties: {
        slotStart: { type: 'string', description: 'Exact slot start returned by check_availability.' },
        name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
        approved: { type: 'boolean', description: 'True only after the caller confirms the time and email and asks to book.' },
      }, required: ['slotStart', 'name', 'email', 'approved'] } },
  ];
}

export const bookingDarlaInstructions = 'For an appointment, use check_availability and offer only returned slots. Appointments are one hour, Monday–Friday noon–4pm America/Indianapolis, with thirty minutes between appointments. Read back the full date, local time, name and email; obtain explicit approval before book_appointment. Only booked=true confirms an appointment. An invitation requested from Google is not proof of inbox delivery or acceptance. If unavailable or uncertain, take a request for Douglas without claiming a reservation. These booking functions do not change owner verification, recording controls, emergency transfer, or voice.';
