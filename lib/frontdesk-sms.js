import { sql } from 'drizzle-orm';
import { frontdeskSecret, OWNER_ADDRESSES } from './frontdesk.js';
import { secretMatches } from './assistant.js';
const xml = body => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { 'Content-Type': 'text/xml', 'Cache-Control': 'no-store' } });
export function createFrontdeskSmsHandler({ getDb, mail, env = process.env }) {
 let ready;
 const ensure = () => ready ||= getDb().execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_frontdesk_sms (message_id text PRIMARY KEY, sender text NOT NULL, recipient text NOT NULL, body text NOT NULL, emailed boolean NOT NULL DEFAULT false, delivering boolean NOT NULL DEFAULT true, claimed_at timestamptz NOT NULL DEFAULT now(), received_at timestamptz NOT NULL DEFAULT now())`)).then(() => getDb().execute(sql.raw('ALTER TABLE legacy_frontdesk_sms ENABLE ROW LEVEL SECURITY'))).catch(error => { ready = null; throw error; });
 return async request => {
  if (request.method !== 'POST') return Response.json({ error: 'POST required.' }, { status: 405 });
  if (!frontdeskSecret(request).some(value => secretMatches(value, env.RECEPTIONIST_WEBHOOK_SECRET))) return Response.json({ error: 'Not authorized.' }, { status: 401 });
  try {
   if (Number(request.headers.get('content-length') || 0) > 16000) return Response.json({ error: 'Too large.' }, { status: 413 });
   const raw = await request.text(); if (Buffer.byteLength(raw) > 16000) return Response.json({ error: 'Too large.' }, { status: 413 });
   const input = new URLSearchParams(raw);
   const sid = input.get('MessageSid') || input.get('SmsSid') || '', from = input.get('From') || '', to = input.get('To') || '', body = (input.get('Body') || '').trim().slice(0, 4000);
   if (!/^[A-Za-z0-9_-]{1,120}$/.test(sid) || !/^\+[1-9]\d{7,14}$/.test(from) || to !== env.FRONTDESK_SMS_FROM || !body) return Response.json({ error: 'Invalid inbound message.' }, { status: 400 });
   await ensure(); const db = getDb();
   const inserted = await db.execute(sql`INSERT INTO legacy_frontdesk_sms(message_id,sender,recipient,body) VALUES (${sid},${from},${to},${body}) ON CONFLICT DO NOTHING RETURNING message_id`);
   if (!inserted.rows.length) {
    const claim = await db.execute(sql`UPDATE legacy_frontdesk_sms SET delivering=true,claimed_at=now() WHERE message_id=${sid} AND emailed=false AND (delivering=false OR claimed_at < now() - interval '5 minutes') RETURNING message_id`);
    if (!claim.rows.length) {
     const existing = (await db.execute(sql`SELECT emailed FROM legacy_frontdesk_sms WHERE message_id=${sid}`)).rows[0];
     if (!existing?.emailed) return Response.json({ error: 'Owner delivery is still pending. Retry later.' }, { status: 503 });
     return xml('');
    }
   }
   const deliveries = await Promise.allSettled(OWNER_ADDRESSES.map(address => mail({ to: address, subject: `New text lead from ${from}`, body: `Customer text received at the Legacy AI front desk.\nFrom: ${from}\nMessage id: ${sid}\n\n${body}\n\nNo appointment has been reserved. Reply or call the customer after review.` })));
   const done = deliveries.every(result => result.status === 'fulfilled');
   await db.execute(sql`UPDATE legacy_frontdesk_sms SET emailed=${done},delivering=false WHERE message_id=${sid}`);
   if (!done) return Response.json({ error: 'Message saved; owner delivery incomplete. Retry later.' }, { status: 503 });
   // Registration controls the reply, not whether incoming leads can be saved.
   // SignalWire requires the application to honor opt-outs. Every incoming
   // control word is already persisted above, even if owner delivery needs retry.
   if (env.FRONTDESK_CUSTOMER_SMS_ENABLED !== 'true' || /^(stop|stopall|unsubscribe|cancel|end|quit|revoke|opt out|help|start|unstop)$/i.test(body)) return xml('');
   // Read the latest control after owner notification: a STOP received while
   // that email was pending must suppress this reply too. Retries do not change
   // received_at, so replaying an old START cannot undo a newer STOP.
   const control = (await db.execute(sql`SELECT lower(btrim(body)) AS keyword FROM legacy_frontdesk_sms
    WHERE sender=${from} AND recipient=${to}
    AND lower(btrim(body)) IN ('stop','stopall','unsubscribe','cancel','end','quit','revoke','opt out','start','unstop')
    ORDER BY received_at DESC, CASE WHEN lower(btrim(body)) IN ('start','unstop') THEN 1 ELSE 0 END ASC, message_id DESC LIMIT 1`)).rows[0];
   if (control && !['start', 'unstop'].includes(control.keyword)) return xml('');
   return xml('<Message>Thanks for contacting Legacy AI. Your message has been sent to Douglas for review. No appointment is confirmed.</Message>');
  } catch { return Response.json({ error: 'Text could not be processed.' }, { status: 500 }); }
 };
}
