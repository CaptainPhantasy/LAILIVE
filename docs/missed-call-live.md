# Call recovery demo backend

Prepared code only. It is disabled by default. No number has been reassigned, no
SignalWire setting changed, and no customer message sent by this implementation.
The current customer campaign was observed Pending; do not enable customer SMS
until its sender is approved and the actual opt-in flow is covered.

The dedicated voice number answers with a short, explicit one-text consent
greeting. Only DTMF 1 records consent for that CallSid and its actual caller ID.
The phone-number-level completed callback then requests a real SMS to that same
caller. A hangup without consent, failed call, blocked number, expired consent,
or exhausted quota sends nothing. Consent is not marketing permission.

This is an answered automated demo greeting followed by a real text. Do not
advertise it as a literally unanswered call or guaranteed immediate delivery.
Caller ID is supplied by the telephony network; it is not an identity-verification
service. Initial pilot limits are one attempt per caller per rolling 24 hours and
20 total attempts per rolling 24 hours, including failed and uncertain attempts.

## Configuration and routing

Both `MISSED_CALL_DEMO_ENABLED=true` and `FRONTDESK_CUSTOMER_SMS_ENABLED=true` are
required. Leave either unset/false until the owner has allocated a number and the
registered sender and consent use case are ready.

| Setting | Purpose |
| --- | --- |
| `MISSED_CALL_DEMO_NUMBER` | E.164 dedicated voice demo number, explicitly allocated by the owner |
| `FRONTDESK_SMS_FROM` | Approved E.164 SMS sender; replies continue through the existing frontdesk SMS handler |
| `MISSED_CALL_WEBHOOK_URL` | Exact public HTTPS URL ending `/api/frontdesk/missed-call`, no query string |
| `SIGNALWIRE_SPACE_HOST` | Existing project host ending `.signalwire.com` |
| `SIGNALWIRE_PROJECT_ID` | Existing project UUID |
| `SIGNALWIRE_API_TOKEN` | Existing token with Messaging scope |
| `SIGNALWIRE_SIGNING_KEY` | Project webhook signing key, distinct from API token/shared webhook secret |
| `DATABASE_URL` | Existing persistent database |

After explicit approval to assign an available number, its Compatibility API
VoiceUrl would be `MISSED_CALL_WEBHOOK_URL?stage=voice` (POST). Its number-level
StatusCallback would be `MISSED_CALL_WEBHOOK_URL?stage=call-ended` (POST). The
greeting generates its own `stage=consent` action. Message creation supplies its
own signed `stage=message-status` callback with a persisted correlation token.
Do not replace another service's number routing. This code makes no such changes.

The existing `legacy_frontdesk_sms` inbox must exist and receive replies to
`FRONTDESK_SMS_FROM`; unavailable history fails closed. The most recent matching
STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT/REVOKE/OPT OUT blocks a send. Only a later
START or UNSTOP removes that block, and a fresh call still needs DTMF consent.
This does not itself correct opt-out handling in other outbound SMS code paths.

## Acceptance and failure handling

After enablement, a real caller must hear the greeting, press 1, hang up, receive
the real message, and reply STOP. A subsequent call from that number must send
nothing. Check the persistent `legacy_missed_call_demo` row: consent timestamp,
call-ended timestamp, dispatch state, MessageSid, and message status are separate.
`accepted`/`queued` is not delivered; `delivered` is carrier-reported delivery.

The database claim precedes one single Messages API POST, with redirects and
automatic retries disabled, a 5-minute queue validity and a $0.02 MaxPrice. A
unique CallSid and serialized quota check prevent duplicate dispatch across
instances. There is no documented provider creation idempotency key, so this is
**at most one dispatch attempt**, not guaranteed exactly-once delivery. Transport
ambiguity is retained as `unknown`; a process interruption may leave `dispatching`.
Neither state is automatically resent. A later authenticated delivery callback
can resolve it; otherwise reconcile against provider logs manually before taking
any action. Missing call callbacks likewise require reconciliation; there is no
background retry job in this pilot.

Sources checked 2026-10-17:

- [Incoming-number completed/failed callback contract](https://signalwire.com/docs/compatibility-api/rest/incoming-phone-numbers/webhooks/incoming-call-status-callback)
- [DTMF Gather action](https://signalwire.com/docs/compatibility-api/cxml/reference/voice/gather)
- [Webhook signatures](https://signalwire.com/docs/compatibility-api/guides/webhook-security)
- [Message creation, MaxPrice, ValidityPeriod and StatusCallback](https://signalwire.com/docs/compatibility-api/rest/messages/create-message)
- [Message status semantics](https://signalwire.com/docs/compatibility-api/rest/messages/webhooks/sms-status-callback)
- [Application-managed STOP/START](https://signalwire.com/developers/demos/r/handle-opt-outs-yourself.html)
- [Advisory callback reliability and reconciliation](https://signalwire.com/docs/platform/webhooks)

Tests use the actual pinned SignalWire signature validator and an isolated
PostgreSQL-compatible database, with an injected local send stub. They incur no
telephony/SMS usage and do not prove a live delivery.
