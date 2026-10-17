-- Front desk call reports (api/frontdesk/message.js). One row per SignalWire call id
-- claims the call, so two overlapping deliveries of the same report cannot both email
-- the owner, and delivery is tracked per channel so a call whose mandatory email failed
-- is delivered again on the next report for that call. The handler creates this table on
-- first use as well, so the endpoint keeps working before this is applied by hand.
CREATE TABLE IF NOT EXISTS legacy_frontdesk_calls (
 call_id text PRIMARY KEY,
 event_id uuid,
 emailed boolean NOT NULL DEFAULT false,
 texted boolean NOT NULL DEFAULT false,
 text_via text,
 text_status text,
 delivering boolean NOT NULL DEFAULT false,
 claimed_at timestamptz NOT NULL DEFAULT now(),
 delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS legacy_frontdesk_calls_claimed_idx ON legacy_frontdesk_calls(claimed_at DESC);
ALTER TABLE legacy_frontdesk_calls ADD COLUMN IF NOT EXISTS text_via text;
ALTER TABLE legacy_frontdesk_calls ADD COLUMN IF NOT EXISTS text_status text;
ALTER TABLE legacy_frontdesk_calls ENABLE ROW LEVEL SECURITY;
