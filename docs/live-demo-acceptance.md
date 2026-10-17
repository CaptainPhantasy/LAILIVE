# Real service demonstrations

This branch targets preview review. The production phone configuration and the
production booking/missed-call pages have not been changed by this work.

## Prepared

- Voice-to-report: browser dictation or typed notes, professionally rewritten
  report, source evidence and separate fidelity review, editable report fields,
  and a downloadable PDF with embedded fonts. The homepage links to it.
- Board: DeepSeek during Monday–Friday, 8am–5pm America/Indianapolis; reusable
  prompt prefix, bounded output, no premium fallback in that window, actual
  provider usage logging, and a text download for completed reports.
- Darla booking: authenticated availability and reservation tools, weekday
  noon–4pm appointments, one-hour duration and thirty-minute buffers. Google
  Calendar receives a deterministic event ID, attendee and sendUpdates=all.
  A requested invitation is not a claim of delivery or recipient acceptance.
- Call recovery: disabled until configured. A dedicated line collects explicit
  keypad consent, and an authenticated call-end callback dispatches one real
  SMS attempt. Delivery status is tracked separately from provider acceptance.
  Existing customer replies now honor persistent opt-outs, including after
  handler restarts and notification failures.

## Evidence and remaining live checks

The failed `feat/darla-live-backend` deployment was corrected at remote commit
`c5cbfef501596aaece6a818483af012b0edcda55`; its replacement deployment is READY.
The exact failing command passed all 47 tests and completed the build.

The combined delivery, Board and report checks passed 85 tests before the final
booking and opt-out additions. The final required build command passed 51 tests
and completed the build. Additional focused checks are documented in the PR.
Actual paid Board/report calls and browser PDF download still require access to
the protected Vercel preview. No measured per-use price or unlimited-use claim
has been made; repeat access remains deliberately disabled pending evidence.

A real Google Calendar freeBusy request succeeded through the existing connected
account. The separate Zapier MCP server used by the application now has its
Google Calendar API Request (Beta) action enabled with the owner's approval.
The workspace recovery removed the temporary copy of its existing connection
URL; Vercel's stored sensitive value cannot be retrieved, and Zapier only shows
the token when generated. Restore the existing connection URL securely as
BOOKING_ZAPIER_MCP_URL for the feat/live-service-demos preview branch, then
inspect tools/list and set BOOKING_ZAPIER_GET_TOOL and BOOKING_ZAPIER_WRITE_TOOL
to the observed runtime action name. No token was rotated. The existing Calendar
account is used; no new Google account is needed.

## Calendar isolation

The owner approved calendar access on October 17, 2026, conditional on keeping
PSI bookings separate. A dedicated **Legacy AI — Darla bookings** calendar was
created in the existing connected account. Its exact ID is pinned by
`LEGACY_BOOKING_CALENDAR_ID` in the provider; `BOOKING_CALENDAR_ID` must match.
The preview branch setting is configured with that ID. Missing, primary or any
other calendar setting disables all calendar calls before network access.
Availability, event creation and receipt lookup use only this dedicated calendar.
No PSI calendar events, settings, phone routes or production settings were changed.
The runtime action is enabled, but the preview remains disabled until the
existing connection secret and verified runtime tool name are configured. A real
booking and invitation still need verification before phone booking is advertised.
The 17 focused Calendar and Darla integration tests pass, including zero network
calls for every disallowed calendar configuration. This is application isolation;
it does not narrow the underlying connected Google account's permissions.

SignalWire readback found the existing campaign still Pending. The two additional
owned numbers remain assigned to PSI resources: 812-998-8227 to its record/SIP
forwarding flow, and 812-407-0607 to a SIP credential. Neither was reassigned.
Do not enable customer SMS until the campaign and sender are approved and the
selected demo line's original routing has been recorded for restoration.

## Acceptance before wider release

1. Sign in to the protected preview and complete a real report, inspect the
   wording against the source, edit it and download the PDF.
2. Measure actual DeepSeek charges and cache usage using the normal inquiry and
   Board flow. A branch-restricted model-only acceptance switch is documented in
   board-cost-controls.md; it does not change the clock or repeat eligibility.
3. Configure Darla's calendar runtime actions. Book one owner-approved test slot,
   verify the actual Google event and invitation, then wire the reviewed tools
   into the intended Darla phone resource before advertising booking there.
4. Allocate the approved text sender/demo line, preserve its current routing,
   and verify an actual consenting caller receives the follow-up and STOP works.
5. Connect the booking/recovery calls to the proven workflows. The pages now
   lead with business outcomes and Talk to Darla, with planning tools underneath.
   Do not advertise six completed live demonstrations until all are verified.
