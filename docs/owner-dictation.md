# Owner dictation and document review

This is a server feature; it does not depend on the owner's computer. No PIN is preselected, no payment provider is called, and no customer delivery occurs during dictation.

## Required host settings

- Existing database and OWNER_NOTIFY_WEBHOOK_URL (must permit owner-approved customer email delivery; verify actual provider acceptance).
- Existing RECEPTIONIST_WEBHOOK_SECRET and RECEPTIONIST_SESSION_SECRET (at least 24 characters).
- FRONTDESK_OWNER_PIN_HASH: a newly chosen owner PIN, stored only as salted scrypt. Format `32 hex salt:64 hex hash`. Use a secure entry mechanism to collect the owner's 6–12 digit PIN and compute `scryptSync(pin, randomBytes(16).toString('hex'), 32)` with the same salt stored before the colon. Do not place digits in chat, shell history, logs or model context.
- FRONTDESK_PUBLIC_ORIGIN: HTTPS origin serving these endpoints, default https://legacyai.space.

Native SWML must gather keypad digits before entering AI owner mode, with `prompt` and terminator `#`, then transfer to authenticated `/api/frontdesk/owner`. The observed callback schema must be verified before routing the live number: `{call:{call_id,from},vars:{prompt_value}}`. Caller must equal +18123405761, but caller ID alone never authorizes an owner action. Three failed attempts per call and twenty per day disable further checks. Missing PIN configuration returns denial SWML.

On success the endpoint returns SWML owner AI with a short-lived, call-bound `save_owner_draft` tool. It takes kind `field_report`, `quote`, `invoice`, or `board_request`, plus confirmed title/content/recipient. It stores the actual dictation and emails both existing owner destinations a signed seven-day review link. Board requests are saved as requests, not presented as generated analysis.

The review page allows text editing, PDF download and explicit POST approval. Customer delivery is disabled without a customer email and for Board requests. Approval locks the record before sending so retries cannot duplicate delivery. A provider failure leaves it in `sending` for manual provider reconciliation; it never automatically retries an uncertain send. Delivery acceptance is not inbox delivery proof. PDF uses built-in Latin-1 fonts; unsupported characters cause an explicit error instead of silently corrupting the report. Text remains editable.

## Remaining integration work

- Verify actual DTMF webhook field names and returned SWML with a real call; no claim of live owner flow completion until then.
- Owner must securely choose the PIN; no invented default.
- Email reply edits are not wired: the delivered review link provides editing. An authenticated inbound email route is still needed for reply-based editing.
- Board analysis is not called automatically; existing `/api/board` uses metered models and needs explicit routing/budget reconciliation.
- These document records do not implement recording retention.
- Add approved logo/template after review; current PDF is a simple editable-text draft layout, with Legacy AI LLC heading.
