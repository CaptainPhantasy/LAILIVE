-- Server functions connect as the database owner. Browser auth roles get no direct rows.
ALTER TABLE legacy_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_inquiry_interests ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_submission_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_follow_up_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_visitor_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_contact_evidence ENABLE ROW LEVEL SECURITY;
