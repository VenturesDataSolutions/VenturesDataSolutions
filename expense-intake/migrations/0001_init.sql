CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT NOT NULL,
  care_plan_tier TEXT,
  twilio_number TEXT NOT NULL UNIQUE,
  accounting_software TEXT NOT NULL CHECK (accounting_software IN ('quickbooks_online', 'quickbooks_desktop', 'wave', 'xero', 'csv')),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE authorized_senders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  phone_number TEXT NOT NULL,
  label TEXT,
  contact_card_sent_at TEXT
);

CREATE UNIQUE INDEX idx_authorized_senders_client_phone ON authorized_senders(client_id, phone_number);

CREATE TABLE houses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  address TEXT NOT NULL,
  nickname TEXT,
  google_sheet_id TEXT
);

CREATE INDEX idx_houses_client ON houses(client_id);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  house_id INTEGER NOT NULL REFERENCES houses(id),
  date TEXT NOT NULL,
  vendor TEXT,
  amount REAL,
  category TEXT NOT NULL CHECK (category IN ('Materials', 'Labor/Contractor', 'Permits & Fees', 'Utilities', 'Insurance', 'Property Tax', 'Mortgage Interest', 'Repairs & Maintenance', 'Professional Services', 'Travel/Mileage', 'Other')),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  photo_r2_key TEXT,
  raw_text TEXT,
  logged_by_phone TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX idx_expenses_house ON expenses(house_id);

CREATE TABLE pending_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  house_id INTEGER REFERENCES houses(id),
  amount_guess REAL,
  category_guess TEXT CHECK (category_guess IS NULL OR category_guess IN ('Materials', 'Labor/Contractor', 'Permits & Fees', 'Utilities', 'Insurance', 'Property Tax', 'Mortgage Interest', 'Repairs & Maintenance', 'Professional Services', 'Travel/Mileage', 'Other')),
  photo_r2_key TEXT,
  raw_text TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_pending_review_client ON pending_review(client_id);
CREATE INDEX idx_pending_review_expires ON pending_review(expires_at);
