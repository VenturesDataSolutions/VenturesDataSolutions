-- expense-intake/migrations/0004_add_email_identity.sql
-- Adds email as a second, independent identity an authorized_sender can have instead of (or
-- alongside) a phone number, and a matching logged_by_email column on expenses. This is the
-- actual A2P 10DLC compliance fix: today authorized_senders.phone_number is NOT NULL, so no
-- one can exist in the system at all without a phone number (and therefore without going
-- through the SMS consent gate) — see
-- docs/superpowers/specs/2026-08-25-expense-intake-email-channel-design.md.
--
-- SQLite/D1 can't ALTER COLUMN to drop a NOT NULL constraint, so both tables are recreated
-- (standard SQLite pattern: new table, copy rows, drop old, rename), then their indexes are
-- re-added since DROP TABLE drops them too.

CREATE TABLE authorized_senders_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  phone_number TEXT,
  email TEXT,
  label TEXT,
  contact_card_sent_at TEXT,
  CHECK (phone_number IS NOT NULL OR email IS NOT NULL)
);

INSERT INTO authorized_senders_new (id, client_id, phone_number, email, label, contact_card_sent_at)
SELECT id, client_id, phone_number, NULL, label, contact_card_sent_at FROM authorized_senders;

DROP TABLE authorized_senders;
ALTER TABLE authorized_senders_new RENAME TO authorized_senders;

CREATE UNIQUE INDEX idx_authorized_senders_client_phone ON authorized_senders(client_id, phone_number);
CREATE UNIQUE INDEX idx_authorized_senders_email ON authorized_senders(email) WHERE email IS NOT NULL;

CREATE TABLE expenses_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  house_id INTEGER NOT NULL REFERENCES houses(id),
  date TEXT NOT NULL,
  vendor TEXT,
  amount REAL,
  category TEXT NOT NULL CHECK (category IN ('Materials', 'Labor/Contractor', 'Permits & Fees', 'Utilities', 'Insurance', 'Property Tax', 'Mortgage Interest', 'Repairs & Maintenance', 'Professional Services', 'Travel/Mileage', 'Other')),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  photo_r2_key TEXT,
  raw_text TEXT,
  logged_by_phone TEXT,
  logged_by_email TEXT,
  notes TEXT,
  sheet_row INTEGER,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CHECK (logged_by_phone IS NOT NULL OR logged_by_email IS NOT NULL)
);

INSERT INTO expenses_new (id, house_id, date, vendor, amount, category, confidence, photo_r2_key, raw_text, logged_by_phone, logged_by_email, notes, sheet_row, created_at)
SELECT id, house_id, date, vendor, amount, category, confidence, photo_r2_key, raw_text, logged_by_phone, NULL, notes, sheet_row, created_at FROM expenses;

DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;

CREATE INDEX idx_expenses_house ON expenses(house_id);
