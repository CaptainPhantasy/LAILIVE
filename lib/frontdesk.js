import { createZapierOwnerTexter } from './zapier-owner-sms.js';
import { sql } from 'drizzle-orm';
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
// Verizon's legacy email-to-text gateway: a mail sent to this address is turned into an
// SMS on the owner's phone, so it is the text route used while SignalWire messaging is
// refused. Verizon is retiring the gateway by 03/31/2027. The address is derived from the
// owner's number rather than written out, so the two cannot drift apart.
export const OWNER_VTEXT_ADDRESS = `${OWNER_NUMBER.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1')}@vtext.com`;
export const OWNER_SMS_FROM_ENV = 'FRONTDESK_SMS_FROM';
// The one action that means a call has finished. SignalWire posts fetch_conversation to
// this same URL when a call starts, and that payload is not a report.
export const REPORT_ACTION = 'post_conversation';
const MAX_REQUEST_BYTES = 262144;
const MAX_IDENTIFIER_CHARS = 120;
const MAX_NUMBER_CHARS = 40;
const MAX_SUMMARY_CHARS = 2000;
const MAX_TEXT_SUMMARY_CHARS = 300;
// An SMS segment holds 160 characters, so the copy sent to the email-to-text gateway is
// cut to about two segments: a longer one would arrive as a wall of texts.
const MAX_TEXT_BODY_CHARS = 300;
// The gateway turns the whole mail into a text, so the subject is only a label for the
// mailbox; it is deliberately not the full front desk subject.
const GATEWAY_SUBJECT = 'Front desk message';
const MAX_TURN_CHARS = 2000;
const MAX_TRANSCRIPT_TURNS = 200;
const MAX_TRANSCRIPT_CHARS = 20000;
// A delivery still marked as running after this long was killed rather than still
// working: the function is capped at 60 seconds and outbound calls have shorter deadlines,
// so anything older than this is a stranded claim that may be taken over.
const IN_FLIGHT_MS = 300000;
const ROLES = new Set(['system', 'assistant', 'user']);
const SPEAKER = { system: 'System', assistant: 'Front desk', user: 'Caller' };

// A caller's words reach an email header and an SMS body, so strip control
// characters and bound the length before anything is composed or stored.
const clean = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';
// An email subject is a single header value, and a caller can put anything on the line,
// so every run of whitespace (including the CR and LF clean() keeps) collapses to one
// space before a name or number is put in a subject.
const singleLine = (value, max) => clean(value, max).replace(/\s+/g, ' ').trim();
const count = value => { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0; };
// SignalWire documents the call times as Unix microseconds; milliseconds and seconds are
// accepted too so a report in any of the three units still produces a call time.
const epochMs = value => value >= 1e15 ? Math.round(value / 1000) : value >= 1e12 ? Math.round(value) : Math.round(value * 1000);
const moment = value => {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    const date = new Date(epochMs(number));
    return Number.isFinite(date.getTime()) ? date.toISOString() : '';
  }
  const stamp = clean(value, 40);
  if (!stamp) return '';
  // A parsed but unrepresentable timestamp would make toISOString throw, so the Date
  // itself is checked rather than only the parse result.
  const parsed = new Date(stamp);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
};
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
  if (basic) {
    const decoded = Buffer.from(basic, 'base64').toString('utf8'), split = decoded.indexOf(':');
    const password = split === -1 ? decoded : decoded.slice(split + 1);
    // A transfer URL written as "user:password@" keeps its percent-encoding when it is
    // rewritten into this header, so the decoded copy is offered first and the literal
    // copy second. Without both, an encoded password can never match the stored secret.
    try { candidates.push(decodeURIComponent(password)); } catch { /* Not percent-encoded. */ }
    candidates.push(password);
  }
  return candidates;
}

export function readTranscript(callLog) {
  const turns = [];
  let chars = 0, truncated = false;
  for (const entry of Array.isArray(callLog) ? callLog : []) {
    if (turns.length >= MAX_TRANSCRIPT_TURNS) { truncated = true; break; }
    const role = typeof entry?.role === 'string' ? entry.role.trim().toLowerCase() : '';
    let content = clean(entry?.content, MAX_TURN_CHARS);
    if (!ROLES.has(role) || !content) continue;
    // Every turn spends what is left of the budget, so the transcript stops at the
    // documented limit instead of overshooting it by almost one whole turn.
    const remaining = MAX_TRANSCRIPT_CHARS - chars;
    if (content.length > remaining) { content = content.slice(0, remaining); truncated = true; }
    if (!content) { truncated = true; break; }
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

// SignalWire may send the recording URL at the top level or inside the parsed
// post_prompt object. Accept either, and keep only an https URL.
export function readRecordingUrl(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const data = source.post_prompt_data && typeof source.post_prompt_data === 'object' ? source.post_prompt_data : {};
  let parsed = data.parsed;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { parsed = null; } }
  const candidate = source.recording_url || source.recordingUrl || source.record_call_url || source.call?.recording_url || (parsed && typeof parsed === 'object' ? parsed.recording_url : '');
  const url = clean(candidate, 2048);
  return /^https:\/\//i.test(url) ? url : '';
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
    // SignalWire documents caller_id_number; caller_id_num is an older name some
    // reports still use, so the documented field wins and the alias is the fallback.
    callerNumber: clean(source.caller_id_number, MAX_NUMBER_CHARS) || clean(source.caller_id_num, MAX_NUMBER_CHARS),
    callerName: clean(source.caller_id_name, MAX_IDENTIFIER_CHARS),
    startedAt: moment(source.call_start_date),
    answeredAt: moment(source.call_answer_date),
    endedAt: moment(source.call_end_date),
    inputTokens: count(source.total_input_tokens),
    outputTokens: count(source.total_output_tokens),
    summary: readSummary(source.post_prompt_data),
    recordingUrl: readRecordingUrl(source),
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
  const visibleTranscript = record.transcript.filter(turn => turn.role !== 'system');
  // Both values come from the call, and a value with a line break in it would end the
  // subject header early, so they are collapsed onto one line for the subject.
  const number = singleLine(record.callerNumber, MAX_NUMBER_CHARS), name = singleLine(record.callerName, MAX_IDENTIFIER_CHARS);
  const who = name ? `${number || 'unknown number'} (${name})` : number || 'unknown number';
  const subject = `Front desk message from ${number || 'an unknown number'}${name ? ` (${name})` : ''}`;
  const body = [
    'Someone called the front desk and left this report.',
    '',
    `Caller: ${who}`,
    ...(record.startedAt ? [`Call started: ${when(record.startedAt)}`] : []),
    ...(record.endedAt ? [`Call ended: ${when(record.endedAt)}`] : []),
    `Call id: ${record.callId || 'not supplied'}`,
    ...(record.recordingUrl ? [`Call recording (MP3): ${record.recordingUrl}`] : []),
    ...(record.conversationId ? [`Conversation: ${record.conversationId}`] : []),
    ...(record.sessionId ? [`AI session: ${record.sessionId}`] : []),
    ...(record.app ? [`Assistant app: ${record.app}`] : []),
    `Tokens: ${record.inputTokens} in / ${record.outputTokens} out`,
    '',
    'Summary',
    record.summary || '(This call arrived without a summary.)',
    '',
    `Transcript (${visibleTranscript.length} turn${visibleTranscript.length === 1 ? '' : 's'}${record.transcriptTruncated ? ', cut short' : ''})`,
    ...(visibleTranscript.length ? visibleTranscript.map(turn => `${SPEAKER[turn.role]}: ${turn.content}`) : ['(This call arrived without a transcript.)']),
    ...(record.transcriptTruncated ? ['', `The transcript was cut short at ${MAX_TRANSCRIPT_TURNS} turns or ${MAX_TRANSCRIPT_CHARS} characters.`] : []),
    '',
    `Captured ${when(record.receivedAt)} by the Legacy AI front desk. Only you receive these messages.`,
  ];
  return { subject, body: body.join('\n') };
}

export function composeFrontdeskText(record) {
  const summary = record.summary.replace(/\s+/g, ' ').slice(0, MAX_TEXT_SUMMARY_CHARS).trim();
  // The message is one sentence, so a name or number with a line break in it is collapsed
  // rather than allowed to split the text into two.
  const number = singleLine(record.callerNumber, MAX_NUMBER_CHARS), name = singleLine(record.callerName, MAX_IDENTIFIER_CHARS);
  const headline = `Front desk message from ${number || 'an unknown number'}${name ? ` (${name})` : ''}.`;
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

// The request cap is counted in bytes as the body arrives, and the read stops the moment
// the cap is passed, so an oversized report is never buffered in full. A payload of
// multi-byte characters costs more bytes than its string length, and the cap is a byte
// cap, so the byte count is what is enforced.
async function readRequestText(request, max) {
  if (Number(request.headers.get('content-length') || 0) > max) throw new HttpError(413, 'Too large.');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let bytes = 0, body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) { await reader.cancel(); throw new HttpError(413, 'Too large.'); }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally { reader.releaseLock(); }
  return body;
}

// One row per call decides which delivery of a call may notify, so two overlapping
// deliveries cannot both insert and both email. The call id is the primary key, which
// makes the claim one atomic statement, and delivery is tracked per channel so a call
// whose mandatory email failed is delivered again on the next report for it.
const CALL_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS legacy_frontdesk_calls (call_id text PRIMARY KEY, event_id uuid, emailed boolean NOT NULL DEFAULT false, texted boolean NOT NULL DEFAULT false, text_via text, text_status text, delivering boolean NOT NULL DEFAULT false, claimed_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz)`,
  `ALTER TABLE legacy_frontdesk_calls ADD COLUMN IF NOT EXISTS text_via text`,
  `ALTER TABLE legacy_frontdesk_calls ADD COLUMN IF NOT EXISTS text_status text`,
  `CREATE INDEX IF NOT EXISTS legacy_frontdesk_calls_claimed_idx ON legacy_frontdesk_calls(claimed_at DESC)`,
  `ALTER TABLE legacy_frontdesk_calls ENABLE ROW LEVEL SECURITY`,
];
function createFrontdeskCallStore(db) {
  const rows = result => result.rows;
  let ready;
  // Keeps the feature working before migrations/0004_frontdesk_calls.sql is applied by
  // hand, the same way the assistant store creates its own table on first use.
  const ensure = () => ready ||= (async () => { for (const statement of CALL_TABLE_DDL) await db.execute(sql.raw(statement)); })().catch(error => { ready = null; throw error; });
  return {
    async claim(callId) { await ensure(); return rows(await db.execute(sql`INSERT INTO legacy_frontdesk_calls(call_id, delivering) VALUES (${callId}, true) ON CONFLICT (call_id) DO NOTHING RETURNING call_id`))[0] || null; },
    async find(callId) { await ensure(); return rows(await db.execute(sql`SELECT call_id, event_id, emailed, texted, text_via, text_status FROM legacy_frontdesk_calls WHERE call_id = ${callId} LIMIT 1`))[0] || null; },
    // Exactly one caller takes a claim over: the statement only matches a claim whose
    // delivery finished, or one left running long enough to have been killed mid-flight.
    async takeOver(callId) { await ensure(); return rows(await db.execute(sql`UPDATE legacy_frontdesk_calls SET delivering = true, claimed_at = now() WHERE call_id = ${callId} AND (delivering = false OR claimed_at <= now() - make_interval(secs => ${IN_FLIGHT_MS / 1000})) RETURNING call_id`))[0] || null; },
    async attachEvent(callId, eventId) { await ensure(); await db.execute(sql`UPDATE legacy_frontdesk_calls SET event_id = ${eventId}::uuid WHERE call_id = ${callId}`); },
    async finishDelivery(callId, { emailed, texted, textVia, textStatus }) { await ensure(); await db.execute(sql`UPDATE legacy_frontdesk_calls SET delivering = false, emailed = emailed OR ${emailed}, texted = texted OR ${texted}, text_via = COALESCE(text_via, ${textVia}), text_status = COALESCE(text_status, ${textStatus}), delivered_at = CASE WHEN (emailed OR ${emailed}) THEN COALESCE(delivered_at, now()) ELSE NULL END WHERE call_id = ${callId}`); },
  };
}

function storedTextOutcome(existing) {
  const via = existing?.text_via || (existing?.texted ? 'unknown' : 'none');
  return {
    texted: via !== 'none' && via !== 'unknown',
    textVia: via,
    ...(via === 'zapier' ? { textStatus: 'queued', textDelivered: false } : via !== 'none' ? { textStatus: existing?.text_status || 'unknown' } : {}),
  };
}

export function createFrontdeskHandler({ getDb, mail, text, zapier: suppliedZapierTexter, env = process.env, now = () => new Date() } = {}) {
  const texter = text || createOwnerTexter({ env });
  const zapierTexter = suppliedZapierTexter || createZapierOwnerTexter({ env });
  return {
    message: async request => {
      try {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
        if (!frontdeskSecret(request).some(candidate => secretMatches(candidate, env.RECEPTIONIST_WEBHOOK_SECRET))) throw new HttpError(401, 'Not authorized.');
        const raw = await readRequestText(request, MAX_REQUEST_BYTES);
        let payload; try { payload = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON request.'); }
        const time = now(), record = readFrontdeskMessage(payload, time);
        // SignalWire posts fetch_conversation to this URL when a call starts, and the
        // finished report with post_conversation. Only a finished call is a call to tell
        // Douglas about: treating a fetch as a report would announce an empty call and
        // then swallow the real report as a repeat of it. Every other action is named in
        // the response and in the log, and nothing is sent for it.
        if (record.action !== REPORT_ACTION) {
          const action = singleLine(record.action, 40);
          console.error('legacy_frontdesk_ignored_action', { action: safe(action) });
          return json({
            ok: true, ignored: true, action, stored: false, emailed: [], texted: false, duplicate: false, callId: record.callId,
            message: action ? `A '${action}' request is not a finished call, so nothing was sent to Douglas.` : 'This request named no action, so nothing was sent to Douglas.',
          });
        }
        // The stored row is only ever the record: a missing or failing database must
        // not stop the owner being told about a call, so it is reported in the body.
        let events = null, calls = null, storeError = '';
        try { const db = getDb(); events = createAssistantStore(db); calls = createFrontdeskCallStore(db); }
        catch (error) { storeError = reason(error); console.error('legacy_frontdesk_store_unavailable', { name: safe(error?.name) }); }
        let claim = null, existing = null;
        if (calls && record.callId) {
          try {
            claim = await calls.claim(record.callId);
            if (!claim) {
              existing = await calls.find(record.callId);
              // Already delivered on both channels: nothing was sent again.
              if (existing?.emailed === true && existing?.texted === true) {
                const previousText = storedTextOutcome(existing);
                const message = previousText.textVia === 'zapier' ? 'This call was emailed; an owner text was queued through Zapier (delivery unconfirmed). Nothing was sent again.'
                  : previousText.textVia === 'unknown' ? 'This call was emailed; its earlier text status is unavailable. Nothing was sent again.'
                    : 'This call was already sent to Douglas; nothing was sent again.';
                return json({ ok: true, duplicate: true, stored: false, emailed: [], ...previousText, callId: record.callId, message });
              }
              // Another delivery of this call holds the claim, so this one reports its own
              // outcome rather than sending a second copy.
              if (!(await calls.takeOver(record.callId))) return json({ ok: true, duplicate: false, inFlight: true, stored: false, emailed: [], ...storedTextOutcome(existing), callId: record.callId, message: 'This call is already being sent to Douglas; nothing was sent again.' });
            }
          } catch (error) { storeError = storeError || reason(error); console.error('legacy_frontdesk_claim_failure', { message: reason(error) }); }
        }
        // Only the delivery holding the claim (or a report with no call id to claim)
        // stores the row, so a repeated report cannot add a second one. A claim whose
        // stored row is missing gets it now, and a claim that already has one is left
        // alone.
        const owns = Boolean(claim || existing) || !record.callId;
        let saved = null;
        if (events && owns && !existing?.event_id) {
          try {
            saved = await events.saveEvent(frontdeskEvent(record));
            if (claim || existing) await calls.attachEvent(record.callId, saved.id);
          } catch (error) { storeError = storeError || reason(error); console.error('legacy_frontdesk_store_failure', { message: reason(error) }); }
        }
        // The two owner emails, the SignalWire text and the gateway mail are independent, and
        // each provider call waits up to 10 seconds; the multi-step Zapier fallback is
        // bounded separately, and owner notifications run alongside the text providers.
        const message = composeFrontdeskMessage(record);
        // The gateway mail carries the same short text as the SignalWire message, cut to
        // about two SMS segments.
        const shortText = composeFrontdeskText(record).slice(0, MAX_TEXT_BODY_CHARS);
        // A channel that already went out for this call is not sent again, so retrying the
        // mandatory email cannot text Douglas a second time.
        const wantEmail = existing?.emailed !== true, wantText = existing?.texted !== true;
        let textError = '';
        const sendOwnerMail = async to => {
          try { await mail({ to, subject: message.subject, body: message.body }); return { to, ok: true }; }
          catch (error) { console.error('legacy_frontdesk_mail_failure', { message: reason(error) }); return { to, ok: false }; }
        };
        const sendText = async () => {
          try { await texter({ to: OWNER_NUMBER, body: composeFrontdeskText(record) }); return 'signalwire'; }
          catch (error) {
            textError = reason(error);
            if (env.ZAPIER_MCP_URL && env.FRONTDESK_ZAPIER_SMS_TOOL_NAME) {
              try { await zapierTexter({ body: composeFrontdeskText(record) }); return 'zapier'; }
              catch (zapierError) { textError += ` Zapier fallback failed: ${reason(zapierError)}`; }
            }
            console.error('legacy_frontdesk_text_failure', { message: textError }); return false;
          }
        };
        // The gateway mail is the fallback text route while SignalWire messaging is refused.
        // Both text routes are attempted together and each failure is caught on its own, so a
        // refused SignalWire text cannot suppress the gateway send and a gateway failure
        // cannot suppress the SignalWire attempt.
        const sendGateway = async () => {
          try { await mail({ to: OWNER_VTEXT_ADDRESS, subject: GATEWAY_SUBJECT, body: shortText }); return true; }
          catch (error) { console.error('legacy_frontdesk_vtext_failure', { message: reason(error) }); return false; }
        };
        const [mails, [signalwire, vtext]] = await Promise.all([
          wantEmail ? Promise.all(OWNER_ADDRESSES.map(sendOwnerMail)) : [],
          wantText ? Promise.all([sendText(), env.FRONTDESK_VTEXT_ENABLED === 'true' ? sendGateway() : false]) : [false, false],
        ]);
        const emailed = mails.filter(result => result.ok).map(result => result.to), emailFailed = mails.filter(result => !result.ok).map(result => result.to);
        // Keep the accepted route and its confirmation level with the call claim so an
        // email retry doesn't turn a queued Zapier request into a delivery claim.
        const attemptedVia = signalwire || (vtext ? 'vtext' : null);
        const textVia = attemptedVia || existing?.text_via || (existing?.texted ? 'unknown' : 'none');
        const textStatus = attemptedVia === 'zapier' ? 'queued' : attemptedVia ? 'accepted' : existing?.text_status || '';
        const texted = textVia !== 'none' && textVia !== 'unknown';
        // The email is the mandatory channel, so a call only counts as told once every
        // owner address has it; a call whose emails failed is delivered again later,
        // where a channel that already went out is left alone.
        const emailDone = existing?.emailed === true || (wantEmail && emailed.length === OWNER_ADDRESSES.length);
        const textDone = (existing?.texted === true && existing?.text_via && existing.text_via !== 'unknown') || (wantText && texted);
        if (calls && record.callId && (claim || existing)) {
          try { await calls.finishDelivery(record.callId, { emailed: emailDone, texted: textDone, textVia: attemptedVia, textStatus: textStatus || null }); }
          catch (error) { console.error('legacy_frontdesk_mark_failure', { message: reason(error) }); }
        }
        const toldRow = saved?.id || existing?.event_id;
        if (emailDone && events && toldRow) {
          try { await events.markEmailed(toldRow); } catch (error) { console.error('legacy_frontdesk_mark_failure', { message: reason(error) }); }
        }
        const told = textVia === 'zapier' ? emailDone ? 'Douglas was emailed; an owner text was queued through Zapier (delivery unconfirmed).' : 'An owner text was queued through Zapier (delivery unconfirmed); the email did not go out.'
          : textVia === 'unknown' ? emailDone ? 'Douglas was emailed; the earlier text outcome is unknown.' : 'The earlier text outcome is unknown and the email did not go out.'
          : emailDone && textDone ? 'Douglas was emailed and texted about this call.'
          : emailDone ? 'Douglas was emailed about this call; the text message did not go out.'
            : textDone ? 'Douglas was texted about this call; the email did not go out.'
              : 'This call was not sent to Douglas. Check the front desk configuration.';
        return json({
          ok: emailDone, stored: Boolean(saved), ...(storeError ? { storageError: storeError } : {}),
          emailed, ...(textVia === 'zapier' ? { textStatus: 'queued', textDelivered: false } : textVia === 'unknown' ? { textStatus: 'unknown' } : {}), ...(emailFailed.length ? { emailFailed } : {}), texted, textVia, ...(textError ? { textError } : {}),
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
