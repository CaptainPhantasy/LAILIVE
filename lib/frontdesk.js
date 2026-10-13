import { HttpError } from './concierge/contracts.js';
import { createAssistantStore, secretMatches, OWNER_TIME_ZONE } from './assistant.js';

// SignalWire's AI receptionist posts one report per finished phone call here.
// Getting the call in front of Douglas is the job, so email and text are attempted
// first and a failure on either channel is reported in the response body instead of
// failing the request. Storing the row and refusing a repeat are best effort.
// Nothing in the payload is trusted: every field is bounded, and every recipient and
// phone number is fixed in this file rather than read from the call.
export const OWNER_ADDRESSES = ['douglas@legacyai.space', 'douglastalley1977@gmail.com'];
export const OWNER_NUMBER = '+18123405761';
export const OWNER_SMS_FROM_ENV = 'FRONTDESK_SMS_FROM';
// SignalWire retries a report it did not get a clean 200 for; the window only
// bounds how far back the duplicate check looks.
const REPEAT_WINDOW_MS = 7 * 86400000;
const MAX_REQUEST_CHARS = 262144;
const MAX_IDENTIFIER_CHARS = 120;
const MAX_NUMBER_CHARS = 40;
const MAX_SUMMARY_CHARS = 2000;
const MAX_TEXT_SUMMARY_CHARS = 300;
const MAX_TURN_CHARS = 2000;
const MAX_TRANSCRIPT_TURNS = 200;
const MAX_TRANSCRIPT_CHARS = 20000;
const ROLES = new Set(['system', 'assistant', 'user']);
const SPEAKER = { system: 'System', assistant: 'Front desk', user: 'Caller' };

// A caller's words reach an email header and an SMS body, so strip control
// characters and bound the length before anything is composed or stored.
const clean = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';
const count = value => { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0; };
const moment = value => { const stamp = clean(value, 40); return stamp && Number.isFinite(Date.parse(stamp)) ? stamp : ''; };
const when = value => new Date(value).toLocaleString('en-US', { timeZone: OWNER_TIME_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const safe = value => typeof value === 'string' && /^[A-Za-z0-9_:. -]{1,200}$/.test(value) ? value : undefined;
// Reported to SignalWire and in the function log, so it stays short, single line
// and free of control characters while still naming what went wrong.
const reason = error => clean(error?.message, 200) || safe(error?.name) || 'error';

// SignalWire embeds the shared secret in the URL as HTTP Basic ("frontdesk:SECRET").
// The same value is accepted in a header so the endpoint still works when a proxy
// drops the user information from the request URL.
export function frontdeskSecret(request) {
  const candidates = [];
  const header = request.headers.get('x-frontdesk-secret');
  if (header) candidates.push(header);
  try {
    const url = new URL(request.url);
    const embedded = url.password || url.username;
    if (embedded) { try { candidates.push(decodeURIComponent(embedded)); } catch { candidates.push(embedded); } }
  } catch { /* A request URL that cannot be parsed simply contributes no secret. */ }
  const basic = request.headers.get('authorization')?.match(/^Basic\s+(\S+)$/i)?.[1];
  if (basic) { const decoded = Buffer.from(basic, 'base64').toString('utf8'), split = decoded.indexOf(':'); candidates.push(split === -1 ? decoded : decoded.slice(split + 1)); }
  return candidates;
}

export function readTranscript(callLog) {
  const turns = [];
  let chars = 0, truncated = false;
  for (const entry of Array.isArray(callLog) ? callLog : []) {
    if (turns.length >= MAX_TRANSCRIPT_TURNS || chars >= MAX_TRANSCRIPT_CHARS) { truncated = true; break; }
    const role = typeof entry?.role === 'string' ? entry.role.trim().toLowerCase() : '';
    const content = clean(entry?.content, MAX_TURN_CHARS);
    if (!ROLES.has(role) || !content) continue;
    turns.push({ role, content });
    chars += content.length;
  }
  return { turns, truncated };
}

// The AI's answer to our post_prompt is the summary; it is the only part of
// post_prompt_data meant for a person, and it may be long or missing.
export function readSummary(postPromptData) {
  const source = postPromptData && typeof postPromptData === 'object' ? postPromptData : {};
  for (const value of [source.raw, source.substituted, source.parsed]) {
    const summary = clean(value, MAX_SUMMARY_CHARS);
    if (summary) return summary;
  }
  return '';
}

export function readFrontdeskMessage(payload, now = new Date()) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const transcript = readTranscript(source.call_log);
  return {
    action: clean(source.action, 40),
    callId: clean(source.call_id, MAX_IDENTIFIER_CHARS),
    conversationId: clean(source.conversation_id, MAX_IDENTIFIER_CHARS),
    sessionId: clean(source.ai_session_id, MAX_IDENTIFIER_CHARS),
    app: clean(source.app_name, MAX_IDENTIFIER_CHARS),
    projectId: clean(source.project_id, MAX_IDENTIFIER_CHARS),
    spaceId: clean(source.space_id, MAX_IDENTIFIER_CHARS),
    contentType: clean(source.content_type, 40),
    version: clean(source.version, 20),
    callerNumber: clean(source.caller_id_num, MAX_NUMBER_CHARS),
    callerName: clean(source.caller_id_name, MAX_IDENTIFIER_CHARS),
    startedAt: moment(source.call_start_date),
    answeredAt: moment(source.call_answer_date),
    endedAt: moment(source.call_end_date),
    inputTokens: count(source.total_input_tokens),
    outputTokens: count(source.total_output_tokens),
    summary: readSummary(source.post_prompt_data),
    transcript: transcript.turns,
    transcriptTruncated: transcript.truncated,
    receivedAt: now.toISOString(),
  };
}

// legacy_assistant_events is the only table saveEvent writes, and its channel
// column already allows 'phone'. contact_request is the one kind it allows for a
// caller who wants to reach Douglas. The call id is kept in conversation_id so a
// repeated report for the same call can be recognised.
export function frontdeskEvent(record) {
  return {
    kind: 'contact_request',
    channel: 'phone',
    visitor_name: record.callerName,
    contact: record.callerNumber,
    question: '',
    summary: record.summary,
    conversation_id: record.callId,
  };
}

export function composeFrontdeskMessage(record) {
  const who = record.callerName ? `${record.callerNumber || 'unknown number'} (${record.callerName})` : record.callerNumber || 'unknown number';
  const subject = `Front desk message from ${record.callerNumber || 'an unknown number'}${record.callerName ? ` (${record.callerName})` : ''}`;
  const body = [
    'Someone called the front desk and left this report.',
    '',
    `Caller: ${who}`,
    ...(record.startedAt ? [`Call started: ${when(record.startedAt)}`] : []),
    ...(record.endedAt ? [`Call ended: ${when(record.endedAt)}`] : []),
    `Call id: ${record.callId || 'not supplied'}`,
    ...(record.conversationId ? [`Conversation: ${record.conversationId}`] : []),
    ...(record.sessionId ? [`AI session: ${record.sessionId}`] : []),
    ...(record.app ? [`Assistant app: ${record.app}`] : []),
    `Tokens: ${record.inputTokens} in / ${record.outputTokens} out`,
    '',
    'Summary',
    record.summary || '(This call arrived without a summary.)',
    '',
    `Transcript (${record.transcript.length} turn${record.transcript.length === 1 ? '' : 's'}${record.transcriptTruncated ? ', cut short' : ''})`,
    ...(record.transcript.length ? record.transcript.map(turn => `${SPEAKER[turn.role]}: ${turn.content}`) : ['(This call arrived without a transcript.)']),
    ...(record.transcriptTruncated ? ['', `The transcript was cut short at ${MAX_TRANSCRIPT_TURNS} turns or ${MAX_TRANSCRIPT_CHARS} characters.`] : []),
    '',
    `Captured ${when(record.receivedAt)} by the Legacy AI front desk. Only you receive these messages.`,
  ];
  return { subject, body: body.join('\n') };
}

export function composeFrontdeskText(record) {
  const summary = record.summary.replace(/\s+/g, ' ').slice(0, MAX_TEXT_SUMMARY_CHARS).trim();
  const headline = `Front desk message from ${record.callerNumber || 'an unknown number'}${record.callerName ? ` (${record.callerName})` : ''}.`;
  return summary ? `${headline} ${summary}` : headline;
}

// SignalWire's messaging REST API takes form fields with Basic auth built from the
// project id and token. The sender is a dedicated front desk number so the text
// thread stays separate from anything else Douglas sends himself.
export function createOwnerTexter({ env = process.env, fetcher = fetch } = {}) {
  return async ({ to, body }) => {
    const host = clean(env.SIGNALWIRE_SPACE_HOST, 200).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const project = clean(env.SIGNALWIRE_PROJECT_ID, 100), token = clean(env.SIGNALWIRE_API_TOKEN, 200), from = clean(env[OWNER_SMS_FROM_ENV], 40);
    if (!host || !project || !token || !from) throw new Error(`${OWNER_SMS_FROM_ENV}, SIGNALWIRE_SPACE_HOST, SIGNALWIRE_PROJECT_ID and SIGNALWIRE_API_TOKEN are all required to send a text.`);
    const response = await fetcher(`https://${host}/api/laml/2010-04-01/Accounts/${project}/Messages.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${project}:${token}`).toString('base64')}` },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`SignalWire messaging returned ${response.status}.`);
    return true;
  };
}

export function createFrontdeskHandler({ getDb, mail, text, env = process.env, now = () => new Date() } = {}) {
  const texter = text || createOwnerTexter({ env });
  return {
    message: async request => {
      try {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
        if (!frontdeskSecret(request).some(candidate => secretMatches(candidate, env.RECEPTIONIST_WEBHOOK_SECRET))) throw new HttpError(401, 'Not authorized.');
        if (Number(request.headers.get('content-length') || 0) > MAX_REQUEST_CHARS) throw new HttpError(413, 'Too large.');
        const raw = await request.text();
        if (raw.length > MAX_REQUEST_CHARS) throw new HttpError(413, 'Too large.');
        let payload; try { payload = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON request.'); }
        const time = now(), record = readFrontdeskMessage(payload, time);
        // Only a call we already delivered is dropped; a row that was stored but never
        // delivered (an earlier mail failure) is kept and told about again rather than
        // swallowed, and that same row records the delivery.
        // The stored row is only ever the record: a missing or failing database must
        // not stop the owner being told about a call, so it is reported in the body.
        let events = null, storeError = '', recorded = null;
        try { events = createAssistantStore(getDb()); }
        catch (error) { storeError = reason(error); console.error('legacy_frontdesk_store_unavailable', { name: safe(error?.name) }); }
        if (events && record.callId) {
          try {
            const since = new Date(time.getTime() - REPEAT_WINDOW_MS);
            recorded = (await events.eventsSince(since)).find(row => row.conversation_id === record.callId) || null;
            if (recorded?.emailed === true) return json({ ok: true, duplicate: true, stored: false, emailed: [], texted: false, callId: record.callId, message: 'This call was already sent to Douglas; nothing was sent again.' });
          } catch (error) { console.error('legacy_frontdesk_repeat_check_failure', { message: reason(error) }); }
        }
        let saved = null;
        if (events && !recorded) {
          try { saved = await events.saveEvent(frontdeskEvent(record)); }
          catch (error) { storeError = reason(error); console.error('legacy_frontdesk_store_failure', { message: reason(error) }); }
        }
        const message = composeFrontdeskMessage(record), emailed = [], emailFailed = [];
        for (const to of OWNER_ADDRESSES) {
          try { await mail({ to, subject: message.subject, body: message.body }); emailed.push(to); }
          catch (error) { emailFailed.push(to); console.error('legacy_frontdesk_mail_failure', { message: reason(error) }); }
        }
        let texted = false, textError = '';
        try { await texter({ to: OWNER_NUMBER, body: composeFrontdeskText(record) }); texted = true; }
        catch (error) { textError = reason(error); console.error('legacy_frontdesk_text_failure', { message: textError }); }
        // The flag means "Douglas has been told", so either channel suppresses the
        // next report for this call; retrying a delivered call would text him twice.
        const toldRow = saved?.id || recorded?.id;
        if ((emailed.length || texted) && toldRow) {
          try { await events.markEmailed(toldRow); } catch (error) { console.error('legacy_frontdesk_mark_failure', { message: reason(error) }); }
        }
        const told = emailed.length && texted ? 'Douglas was emailed and texted about this call.'
          : emailed.length ? 'Douglas was emailed about this call; the text message did not go out.'
            : texted ? 'Douglas was texted about this call; the email did not go out.'
              : 'This call was not sent to Douglas. Check the front desk configuration.';
        return json({
          ok: emailed.length > 0, stored: Boolean(saved), ...(storeError ? { storageError: storeError } : {}),
          emailed, ...(emailFailed.length ? { emailFailed } : {}), texted, ...(textError ? { textError } : {}),
          duplicate: false, callId: record.callId, message: told,
        });
      } catch (error) {
        if (error instanceof HttpError) return json({ error: error.message }, error.status);
        // Nothing has been sent yet, so a retry is worth asking for.
        console.error('legacy_frontdesk_failure', { name: safe(error?.name), message: reason(error) });
        return json({ ok: false, error: 'This call report could not be processed.' }, 500);
      }
    },
  };
}
