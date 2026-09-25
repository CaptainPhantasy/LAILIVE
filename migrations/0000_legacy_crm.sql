CREATE TABLE legacy_contacts (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  company text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE legacy_inquiries (
  id uuid PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES legacy_contacts(id),
  message text NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','reviewed','closed')),
  catalog_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legacy_inquiries_created_idx ON legacy_inquiries(created_at DESC);
CREATE TABLE legacy_inquiry_interests (
  inquiry_id uuid NOT NULL REFERENCES legacy_inquiries(id) ON DELETE CASCADE,
  service_id text NOT NULL,
  service_name text NOT NULL,
  source text NOT NULL DEFAULT 'visitor-selected' CHECK (source = 'visitor-selected'),
  PRIMARY KEY (inquiry_id, service_id)
);
CREATE TABLE legacy_consent_events (
  id uuid PRIMARY KEY,
  inquiry_id uuid NOT NULL REFERENCES legacy_inquiries(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES legacy_contacts(id),
  purpose text NOT NULL CHECK (purpose IN ('inquiry-reply','marketing')),
  channel text NOT NULL CHECK (channel = 'email'),
  choice text NOT NULL CHECK (choice IN ('granted','declined','withdrawn')),
  notice_version text NOT NULL,
  notice_text text NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE legacy_submission_receipts (
  idempotency_key uuid PRIMARY KEY,
  body_hash text NOT NULL,
  inquiry_id uuid NOT NULL REFERENCES legacy_inquiries(id) DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE legacy_follow_up_drafts (
  id uuid PRIMARY KEY,
  inquiry_id uuid NOT NULL REFERENCES legacy_inquiries(id) ON DELETE CASCADE,
  owner_subject text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state = 'draft'),
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE legacy_rate_limits (
  bucket text PRIMARY KEY,
  count integer NOT NULL CHECK (count > 0),
  expires_at timestamptz NOT NULL
);
