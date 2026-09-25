CREATE TABLE legacy_visitor_contacts (
 visitor_id uuid PRIMARY KEY,
 identifiers jsonb NOT NULL,
 ip_addresses jsonb NOT NULL DEFAULT '[]',
 pages jsonb NOT NULL DEFAULT '[]',
 signals jsonb NOT NULL,
 first_seen timestamptz NOT NULL DEFAULT now(),
 last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE legacy_contact_evidence (
 id uuid PRIMARY KEY,
 visitor_id uuid NOT NULL REFERENCES legacy_visitor_contacts(visitor_id),
 identifiers jsonb NOT NULL,
 page text NOT NULL,
 field_name text NOT NULL,
 signals jsonb NOT NULL,
 notice_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legacy_visitor_contacts_recent_idx ON legacy_visitor_contacts(last_seen DESC);
