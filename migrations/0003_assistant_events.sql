-- Site assistant (ElevenLabs agent) escalations and the owner digest log.
CREATE TABLE IF NOT EXISTS legacy_assistant_events (
 id uuid PRIMARY KEY,
 kind text NOT NULL CHECK (kind IN ('contact_request','unanswered_question')),
 channel text NOT NULL DEFAULT 'web' CHECK (channel IN ('web','phone')),
 visitor_name text NOT NULL DEFAULT '',
 contact text NOT NULL DEFAULT '',
 question text NOT NULL DEFAULT '',
 summary text NOT NULL DEFAULT '',
 conversation_id text NOT NULL DEFAULT '',
 emailed boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS legacy_assistant_events_recent_idx ON legacy_assistant_events(created_at DESC);
ALTER TABLE legacy_assistant_events ENABLE ROW LEVEL SECURITY;
