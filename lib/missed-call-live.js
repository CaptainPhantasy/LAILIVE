import { randomUUID } from 'node:crypto';
import { validateRequest } from '@signalwire/sdk';
import { sql } from 'drizzle-orm';

// This demo answers with a consent greeting. It demonstrates a real post-call
// text; a completed IVR call must not be described as an unanswered phone call.
export const MISSED_CALL_DISCLOSURE_VERSION = 'legacy-ai-post-call-demo-v1';
export const MISSED_CALL_DISCLOSURE = 'This is the Legacy AI call recovery demo. Press 1 to request one automated demo text at the number you are calling from after this call ends. Message and data rates may apply. Reply STOP to opt out. No purchase is required. Otherwise, hang up.';
export const MISSED_CALL_MESSAGE = 'Legacy AI: This is the follow-up text you requested on our demo call. Reply here to tell Douglas what you need. Reply STOP to opt out.';
const PHONE = /^\+[1-9]\d{7,14}$/;
const ID = /^[A-Za-z0-9_-]{1,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_RANK = { queued: 1, sending: 2, sent: 3, failed: 4, undelivered: 4, delivered: 5 };
const statusRank = status => Object.hasOwn(STATUS_RANK, status) ? STATUS_RANK[status] : null;
const CONSENT_WINDOW_MS = 15 * 60 * 1000;
const xmlEscape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const xml = body => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { 'Content-Type': 'text/xml', 'Cache-Control': 'no-store' } });
const error = (status, message) => Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
const callbackUrl = (config, stage, extra = {}) => `${config.webhookUrl}?${new URLSearchParams({ stage, ...extra })}`;

function configuration(env) {
  const host = (env.SIGNALWIRE_SPACE_HOST || '').replace(/^https:\/\//, '').replace(/\/$/, '');
  const webhookUrl = env.MISSED_CALL_WEBHOOK_URL || '';
  let parsed;
  try { parsed = new URL(webhookUrl); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/api/frontdesk/missed-call'
    || !/^[a-z0-9-]+\.signalwire\.com$/i.test(host) || !UUID.test(env.SIGNALWIRE_PROJECT_ID || '')
    || !env.SIGNALWIRE_API_TOKEN || !env.SIGNALWIRE_SIGNING_KEY
    || !PHONE.test(env.MISSED_CALL_DEMO_NUMBER || '') || !PHONE.test(env.FRONTDESK_SMS_FROM || '')) return null;
  return { host, webhookUrl, project: env.SIGNALWIRE_PROJECT_ID, token: env.SIGNALWIRE_API_TOKEN, signingKey: env.SIGNALWIRE_SIGNING_KEY,
    demoNumber: env.MISSED_CALL_DEMO_NUMBER, smsFrom: env.FRONTDESK_SMS_FROM,
    enabled: env.MISSED_CALL_DEMO_ENABLED === 'true' && env.FRONTDESK_CUSTOMER_SMS_ENABLED === 'true' };
}

export function createMissedCallLiveHandler({ getDb, env = process.env, fetcher = fetch, now = () => new Date() }) {
  let ready;
  const ensure = () => ready ||= (async () => {
    const db = getDb();
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_missed_call_demo (
      call_id text PRIMARY KEY, caller text NOT NULL, demo_number text NOT NULL, sms_from text NOT NULL,
      disclosure_version text NOT NULL, created_at timestamptz NOT NULL, consent_at timestamptz,
      ended_at timestamptz, call_status text, dispatch_state text NOT NULL DEFAULT 'waiting',
      suppression_reason text, attempt_at timestamptz, dispatch_token text, message_id text UNIQUE,
      message_status text, message_status_rank integer NOT NULL DEFAULT 0, error_code text,
      updated_at timestamptz NOT NULL
    )`));
    await db.execute(sql.raw('ALTER TABLE legacy_missed_call_demo ENABLE ROW LEVEL SECURITY'));
    await db.execute(sql.raw('CREATE INDEX IF NOT EXISTS legacy_missed_call_demo_attempt ON legacy_missed_call_demo(attempt_at) WHERE attempt_at IS NOT NULL'));
    await db.execute(sql.raw('CREATE TABLE IF NOT EXISTS legacy_missed_call_demo_lock (id integer PRIMARY KEY)'));
    await db.execute(sql.raw('ALTER TABLE legacy_missed_call_demo_lock ENABLE ROW LEVEL SECURITY'));
    await db.execute(sql`INSERT INTO legacy_missed_call_demo_lock(id) VALUES (1) ON CONFLICT DO NOTHING`);
  })().catch(cause => { ready = null; throw cause; });

  // The existing SMS handler saves incoming STOP/START records before delivering
  // owner email. Missing/unreadable history must fail closed, never assume consent.
  const optedOut = async (db, caller, smsFrom) => {
    const result = await db.execute(sql`SELECT lower(btrim(body)) AS keyword FROM legacy_frontdesk_sms
      WHERE sender=${caller} AND recipient=${smsFrom}
      AND lower(btrim(body)) IN ('stop','stopall','unsubscribe','cancel','end','quit','revoke','opt out','start','unstop')
      ORDER BY received_at DESC, CASE WHEN lower(btrim(body)) IN ('start','unstop') THEN 1 ELSE 0 END ASC, message_id DESC LIMIT 1`);
    return !!result.rows[0] && !['start', 'unstop'].includes(result.rows[0].keyword);
  };

  const recordMessage = async (db, call, message, time) => {
    const rank = statusRank(message.status);
    if (!ID.test(message.sid || '') || !rank) return false;
    const updated = await db.execute(sql`UPDATE legacy_missed_call_demo SET
      message_id=${message.sid}, dispatch_state='accepted', message_status=${message.status}, message_status_rank=${rank},
      error_code=${/^\d{1,10}$/.test(String(message.errorCode || '')) ? String(message.errorCode) : null}, updated_at=${time}
      WHERE call_id=${call.call_id} AND dispatch_token=${call.dispatch_token} AND attempt_at IS NOT NULL
      AND (message_id IS NULL OR message_id=${message.sid}) AND message_status_rank < ${rank} RETURNING call_id`);
    return updated.rows.length > 0;
  };

  const dispatch = async (config, callId, time) => {
    const db = getDb();
    const call = await db.transaction(async tx => {
      // Serialize quota checks across instances and different CallSids. The
      // durable claim is committed before touching the external Messages API.
      await tx.execute(sql`SELECT id FROM legacy_missed_call_demo_lock WHERE id=1 FOR UPDATE`);
      const result = await tx.execute(sql`SELECT * FROM legacy_missed_call_demo WHERE call_id=${callId} FOR UPDATE`);
      const row = result.rows[0];
      if (!row || row.dispatch_state !== 'waiting' || !row.ended_at) return null;
      let reason = !row.consent_at ? 'no_consent' : row.call_status !== 'completed' ? 'call_failed' : null;
      if (!reason && time.getTime() - new Date(row.consent_at).getTime() > CONSENT_WINDOW_MS) reason = 'consent_expired';
      if (!reason && await optedOut(tx, row.caller, row.sms_from)) reason = 'opted_out';
      if (!reason) {
        const since = new Date(time.getTime() - 86400000).toISOString();
        const counts = await tx.execute(sql`SELECT count(*) AS total,
          count(*) FILTER (WHERE caller=${row.caller}) AS caller_total
          FROM legacy_missed_call_demo WHERE attempt_at > ${since}`);
        if (Number(counts.rows[0].caller_total) >= 1) reason = 'caller_limit';
        else if (Number(counts.rows[0].total) >= 20) reason = 'global_limit';
      }
      if (reason) {
        await tx.execute(sql`UPDATE legacy_missed_call_demo SET dispatch_state='suppressed', suppression_reason=${reason}, updated_at=${time.toISOString()} WHERE call_id=${callId}`);
        return null;
      }
      const token = randomUUID();
      await tx.execute(sql`UPDATE legacy_missed_call_demo SET dispatch_state='dispatching', attempt_at=${time.toISOString()}, dispatch_token=${token}, updated_at=${time.toISOString()} WHERE call_id=${callId}`);
      return { ...row, dispatch_token: token };
    });
    if (!call) return;

    // A timeout can mean the provider accepted the message but the reply was
    // lost. Never retry this POST. Reconcile unknown/dispatching rows manually.
    let failureState = 'unknown', failureCode = 'transport_unknown';
    try {
      const response = await fetcher(`https://${config.host}/api/laml/2010-04-01/Accounts/${config.project}/Messages.json`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${config.project}:${config.token}`).toString('base64')}` },
        body: new URLSearchParams({ From: call.sms_from, To: call.caller, Body: MISSED_CALL_MESSAGE, MaxPrice: '0.02', ValidityPeriod: '300',
          StatusCallback: callbackUrl(config, 'message-status', { call: call.call_id, token: call.dispatch_token }) }),
      });
      if (response.ok) {
        const result = await response.json();
        if (result.account_sid === config.project && result.from === call.sms_from && result.to === call.caller
          && ID.test(result.sid || '') && statusRank(result.status)) {
          await recordMessage(db, call, { sid: result.sid, status: result.status, errorCode: result.error_code }, now().toISOString());
          return;
        }
        failureCode = 'invalid_provider_response';
      } else {
        failureState = response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown';
        failureCode = `http_${response.status}`;
      }
    } catch { /* Preserve the uncertainty, without logging credentials or PII. */ }
    // A delivery callback may have already proved acceptance before fetch ended.
    await db.execute(sql`UPDATE legacy_missed_call_demo SET dispatch_state=${failureState}, error_code=${failureCode}, updated_at=${now().toISOString()}
      WHERE call_id=${call.call_id} AND dispatch_state='dispatching' AND message_id IS NULL`);
  };

  return async request => {
    if (request.method !== 'POST') return error(405, 'POST required.');
    const config = configuration(env);
    if (!config) return error(503, 'Call recovery demo is not configured.');
    try {
      const url = new URL(request.url), stage = url.searchParams.get('stage') || '';
      const allowedKeys = stage === 'message-status' ? ['stage', 'call', 'token'] : ['stage'];
      if (!['voice', 'consent', 'call-ended', 'message-status'].includes(stage) || url.pathname !== '/api/frontdesk/missed-call'
        || [...url.searchParams.keys()].some(key => !allowedKeys.includes(key) || url.searchParams.getAll(key).length !== 1)) return error(400, 'Invalid callback.');
      if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return error(415, 'Form data required.');
      if (Number(request.headers.get('content-length') || 0) > 16000) return error(413, 'Too large.');
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 16000) return error(413, 'Too large.');
      const input = new URLSearchParams(raw);
      if ([...input.keys()].some(key => input.getAll(key).length !== 1)) return error(400, 'Duplicate callback fields.');
      // Parse form tuples for Scheme B. This avoids the SDK raw-body helper's
      // permissive empty-form fallback. Never derive the public host from headers.
      const signature = request.headers.get('x-signalwire-signature') || request.headers.get('x-twilio-signature') || '';
      if (!validateRequest(config.signingKey, signature, config.webhookUrl + url.search, [...input])) return error(401, 'Invalid webhook signature.');
      if (input.get('AccountSid') !== config.project) return error(400, 'Invalid project.');
      if (!config.enabled && stage !== 'message-status') return error(503, 'Call recovery demo is disabled.');
      const time = now(), timestamp = time.toISOString();

      if (stage === 'message-status') {
        const callId = url.searchParams.get('call') || '', token = url.searchParams.get('token') || '';
        const sid = input.get('MessageSid') || '', status = input.get('MessageStatus') || '';
        if (!ID.test(callId) || !UUID.test(token) || !ID.test(sid) || !statusRank(status)) return error(400, 'Invalid message status.');
        await ensure();
        const db = getDb();
        const result = await db.execute(sql`SELECT * FROM legacy_missed_call_demo WHERE call_id=${callId} AND dispatch_token=${token}`);
        const call = result.rows[0];
        if (!call || input.get('From') !== call.sms_from || input.get('To') !== call.caller) return error(400, 'Unknown message.');
        await recordMessage(db, call, { sid, status, errorCode: input.get('ErrorCode') }, timestamp);
        return xml('');
      }

      const callId = input.get('CallSid') || '', caller = input.get('From') || '', to = input.get('To') || '';
      if (!ID.test(callId) || !PHONE.test(caller) || to !== config.demoNumber || [config.smsFrom, config.demoNumber].includes(caller)
        || (input.has('Direction') && input.get('Direction') !== 'inbound')) return error(400, 'Invalid inbound call.');
      await ensure();
      const db = getDb();
      if (stage === 'voice') {
        await db.execute(sql`INSERT INTO legacy_missed_call_demo(call_id,caller,demo_number,sms_from,disclosure_version,created_at,updated_at)
          VALUES (${callId},${caller},${to},${config.smsFrom},${MISSED_CALL_DISCLOSURE_VERSION},${timestamp},${timestamp}) ON CONFLICT DO NOTHING`);
      }
      const result = await db.execute(sql`SELECT * FROM legacy_missed_call_demo WHERE call_id=${callId}`);
      const call = result.rows[0];
      if (!call) return xml(''); // A status-only event cannot invent consent.
      if (call.caller !== caller || call.demo_number !== to || call.sms_from !== config.smsFrom) return error(409, 'Call identity changed.');

      if (stage === 'voice') {
        if (call.ended_at || call.consent_at || call.dispatch_state !== 'waiting') return xml('<Hangup/>');
        if (await optedOut(db, caller, call.sms_from)) return xml('<Say>This number has opted out of Legacy AI texts. No demo text will be sent. Goodbye.</Say><Hangup/>');
        return xml(`<Gather input="dtmf" numDigits="1" timeout="8" method="POST" action="${xmlEscape(callbackUrl(config, 'consent'))}"><Say>${xmlEscape(MISSED_CALL_DISCLOSURE)}</Say></Gather><Say>No text was requested. Goodbye.</Say><Hangup/>`);
      }
      if (stage === 'consent') {
        if (input.get('Digits') !== '1' || call.ended_at || time.getTime() - new Date(call.created_at).getTime() > CONSENT_WINDOW_MS) return xml('<Say>No text was requested. Goodbye.</Say><Hangup/>');
        if (await optedOut(db, caller, call.sms_from)) return xml('<Say>This number has opted out of Legacy AI texts. No demo text will be sent. Goodbye.</Say><Hangup/>');
        await db.execute(sql`UPDATE legacy_missed_call_demo SET consent_at=COALESCE(consent_at,${timestamp}), updated_at=${timestamp}
          WHERE call_id=${callId} AND ended_at IS NULL AND dispatch_state='waiting'`);
        return xml('<Say>Thank you. Your demo text request is saved. You can hang up now. Goodbye.</Say><Hangup/>');
      }
      const status = input.get('CallStatus');
      if (!['completed', 'failed'].includes(status)) return xml('');
      await db.execute(sql`UPDATE legacy_missed_call_demo SET ended_at=${timestamp}, call_status=${status}, updated_at=${timestamp} WHERE call_id=${callId} AND ended_at IS NULL`);
      await dispatch(config, callId, time);
      return xml('');
    } catch { return error(503, 'Call recovery callback could not be processed.'); }
  };
}
