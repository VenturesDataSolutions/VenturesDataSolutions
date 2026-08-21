-- expense-intake/migrations/0003_add_sms_consents.sql
-- Records SMS opt-in consent captured from the client themselves, before their phone number
-- can be entered as an authorized_sender. This is the evidentiary record a carrier or
-- regulator would ask for after an A2P 10DLC campaign rejection over missing opt-in proof.

CREATE TABLE sms_consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number TEXT NOT NULL,
  consent_text TEXT NOT NULL,
  consented_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX idx_sms_consents_phone ON sms_consents(phone_number);
