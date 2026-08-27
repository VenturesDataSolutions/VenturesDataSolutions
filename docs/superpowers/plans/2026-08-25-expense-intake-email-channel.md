# Expense Intake Worker — Email Receipt Intake Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a VDS Expense Tracker subscriber log a receipt by emailing a photo to `receipts@intake.venturesdatasolutions.com` instead of texting it, so SMS opt-in is no longer effectively required to use the product (the A2P 10DLC campaign was rejected for exactly this reason).

**Architecture:** Add a second, independent identity (`email`) an `authorized_senders` row can have instead of (or alongside) a phone number. A new Cloudflare Email Routing rule on a dedicated subdomain delivers inbound mail to this same Worker's new `email()` handler, which parses the MIME message, resolves the sender by email address, and calls straight into the exact same parse/categorize/house-matching/Sheet-filing pipeline SMS already uses. Replies go out via the `send_email` binding.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), R2, Cloudflare Images, KV, Cloudflare Email Routing + Email Sending (`send_email` binding), `postal-mime` (new dependency, MIME parsing).

**Spec:** `docs/superpowers/specs/2026-08-25-expense-intake-email-channel-design.md`

---

## Before you start

All commands below run from the `expense-intake/` directory unless stated otherwise. Run the full suite after every task:

```bash
cd expense-intake
node test/run-all.js
```

It must print `ALL EXPENSE-INTAKE WORKER TESTS PASSED` with no failures before you move to the next task.

---

### Task 1: Migration — `authorized_senders.email` + `expenses.logged_by_email`

**Files:**
- Create: `expense-intake/migrations/0004_add_email_identity.sql`
- Test: `expense-intake/test/migration-0004.test.js`
- Modify: `expense-intake/test/run-all.js`

Today `authorized_senders.phone_number` is `NOT NULL` — no one can exist in the system without a phone number, which is the actual compliance bug. SQLite/D1 can't `ALTER COLUMN` to drop a `NOT NULL` constraint, so both affected tables are recreated (standard SQLite pattern), and their indexes re-added since `DROP TABLE` drops them too.

- [ ] **Step 1: Write the failing schema test**

```javascript
// expense-intake/test/migration-0004.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(__dirname, '..', 'migrations', '0004_add_email_identity.sql');

async function main() {
  assert(fs.existsSync(migrationPath), 'migrations/0004_add_email_identity.sql missing');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert(/CREATE TABLE authorized_senders_new/.test(sql), 'must recreate authorized_senders (SQLite cannot drop a NOT NULL constraint in place)');
  assert(/phone_number TEXT,/.test(sql), 'authorized_senders.phone_number must become nullable');
  assert(/email TEXT,/.test(sql), 'authorized_senders must gain an email column');
  assert(/CHECK \(phone_number IS NOT NULL OR email IS NOT NULL\)/.test(sql), 'authorized_senders must require at least one identity');
  assert(/CREATE UNIQUE INDEX idx_authorized_senders_email ON authorized_senders\(email\) WHERE email IS NOT NULL/.test(sql), 'email must be globally unique (a shared inbox has no per-client "To" signal, unlike SMS)');
  assert(/CREATE UNIQUE INDEX idx_authorized_senders_client_phone ON authorized_senders\(client_id, ?phone_number\)/.test(sql), 'the original (client_id, phone_number) unique index must be re-created after the table recreation');

  assert(/CREATE TABLE expenses_new/.test(sql), 'must recreate expenses (same NOT NULL relaxation need)');
  assert(/logged_by_phone TEXT,/.test(sql), 'expenses.logged_by_phone must become nullable');
  assert(/logged_by_email TEXT,/.test(sql), 'expenses must gain a logged_by_email column');
  assert(/CHECK \(logged_by_phone IS NOT NULL OR logged_by_email IS NOT NULL\)/.test(sql), 'expenses must require at least one identity');
  assert(/CREATE INDEX idx_expenses_house ON expenses\(house_id\)/.test(sql), 'the original expenses(house_id) index must be re-created after the table recreation');

  console.log('PASS: migration-0004.test.js');
}

await main();
```

- [ ] **Step 2: Register it in run-all.js and run to verify it fails**

Add near the other migration imports in `expense-intake/test/run-all.js`:
```javascript
import './migration-0004.test.js';
```
(place it right after `import './migration-0003.test.js';`)

Run: `node test/migration-0004.test.js`
Expected: FAIL — `migrations/0004_add_email_identity.sql missing`

- [ ] **Step 3: Write the migration**

```sql
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test/migration-0004.test.js`
Expected: `PASS: migration-0004.test.js`

- [ ] **Step 5: Commit**

```bash
git add expense-intake/migrations/0004_add_email_identity.sql expense-intake/test/migration-0004.test.js expense-intake/test/run-all.js
git commit -m "Add migration relaxing authorized_senders/expenses to support email identity"
```

---

### Task 2: `db.js` — sender-by-email lookup + `logged_by_email` on insert

**Files:**
- Modify: `expense-intake/src/db.js`
- Modify: `expense-intake/test/db.test.js`

- [ ] **Step 1: Update the failing tests**

In `expense-intake/test/db.test.js`, add `findAuthorizedSenderByEmail,` as a new line inside the existing `import { findClientByTwilioNumber, ... } from '../src/db.js';` block (e.g. right after the `findClientById,` line), then replace the two existing `insertExpense` test blocks (currently around line 63–92: the `// insertExpense: now binds 11 params...` block and the `// insertExpense: notes defaults...` block) with:

```javascript
  // insertExpense: now binds 12 params (adds logged_by_email) and returns the new row's id
  const db6 = createFakeD1();
  const newExpenseId = await insertExpense(db6, {
    houseId: 10, date: '2026-08-17', vendor: 'Home Depot', amount: 42.5, category: 'Materials',
    confidence: 0.9, photoR2Key: 'receipts/x/1.jpg', rawText: 'HD $42.50', loggedByPhone: '+15551234567', notes: '', sheetRow: 5,
  });
  const insertCall = db6.calls[0];
  assert(insertCall.sql.includes('INSERT INTO expenses'), 'insertExpense must INSERT into the expenses table');
  assert(insertCall.params[0] === 10 && insertCall.params[1] === '2026-08-17' && insertCall.params[4] === 'Materials', 'must bind house_id, date, and category in the expected column order');
  assert(
    JSON.stringify(insertCall.params) === JSON.stringify([
      10, '2026-08-17', 'Home Depot', 42.5, 'Materials', 0.9, 'receipts/x/1.jpg', 'HD $42.50', '+15551234567', null, '', 5,
    ]),
    'insertExpense must bind all 12 params (house_id, date, vendor, amount, category, confidence, photo_r2_key, raw_text, logged_by_phone, logged_by_email, notes, sheet_row) in exact column order'
  );
  assert(newExpenseId === 1, "insertExpense must return the new row's id from result.meta.last_row_id");

  // insertExpense: an email-logged expense binds logged_by_email and leaves logged_by_phone null
  const db6b = createFakeD1();
  await insertExpense(db6b, {
    houseId: 10, date: '2026-08-17', vendor: 'Home Depot', amount: 42.5, category: 'Materials',
    confidence: 0.9, photoR2Key: null, rawText: 'HD $42.50', loggedByEmail: 'owner@acme.com', notes: '', sheetRow: 6,
  });
  assert(
    JSON.stringify(db6b.calls[0].params) === JSON.stringify([
      10, '2026-08-17', 'Home Depot', 42.5, 'Materials', 0.9, null, 'HD $42.50', null, 'owner@acme.com', '', 6,
    ]),
    'insertExpense must bind logged_by_email and leave logged_by_phone null for an email-logged expense'
  );

  // insertExpense: notes defaults to empty string and sheet_row defaults to null when omitted
  const db7 = createFakeD1();
  await insertExpense(db7, {
    houseId: 10, date: '2026-08-17', vendor: null, amount: null, category: 'Other',
    confidence: 0.2, photoR2Key: null, rawText: '', loggedByPhone: '+15551234567',
  });
  assert(db7.calls[0].params[10] === '', 'insertExpense must default a missing notes value to an empty string, not undefined');
  assert(
    JSON.stringify(db7.calls[0].params) === JSON.stringify([
      10, '2026-08-17', null, null, 'Other', 0.2, null, '', '+15551234567', null, '', null,
    ]),
    'insertExpense must bind all 12 params correctly even when vendor/amount/photoR2Key/loggedByEmail/sheet_row are null and notes is omitted'
  );
```

Then add, right after the `findClientById` test block near the end of the file (before the closing of `main()`):

```javascript
  // findAuthorizedSenderByEmail
  const emailSenderRow = { id: 9, client_id: 1, email: 'owner@acme.com', phone_number: null };
  const db9 = createFakeD1({
    'SELECT * FROM authorized_senders WHERE email = ?': emailSenderRow,
  });
  const foundByEmail = await findAuthorizedSenderByEmail(db9, 'owner@acme.com');
  assert(foundByEmail === emailSenderRow, 'findAuthorizedSenderByEmail must return the row from the fake DB');
  assert(db9.calls[0].params[0] === 'owner@acme.com', 'must bind the email as the query parameter');

  // findAuthorizedSenderByEmail: not found
  const db10 = createFakeD1({ 'SELECT * FROM authorized_senders WHERE email = ?': null });
  const missingByEmail = await findAuthorizedSenderByEmail(db10, 'nobody@example.com');
  assert(missingByEmail === null, 'findAuthorizedSenderByEmail must return null when no sender matches');
```

Run: `node test/db.test.js`
Expected: FAIL — `findAuthorizedSenderByEmail is not a function` (and the updated `insertExpense` assertions fail against the old 11-param SQL/bind order)

- [ ] **Step 2: Update `src/db.js`**

Replace the existing `insertExpense` function:

```javascript
export async function insertExpense(db, { houseId, date, vendor, amount, category, confidence, photoR2Key, rawText, loggedByPhone, loggedByEmail, notes, sheetRow }) {
  const result = await db
    .prepare('INSERT INTO expenses (house_id, date, vendor, amount, category, confidence, photo_r2_key, raw_text, logged_by_phone, logged_by_email, notes, sheet_row) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(houseId, date, vendor, amount, category, confidence, photoR2Key, rawText, loggedByPhone ?? null, loggedByEmail ?? null, notes || '', sheetRow ?? null)
    .run();
  return result.meta.last_row_id;
}
```

Add near `findClientById`:

```javascript
export async function findAuthorizedSenderByEmail(db, email) {
  return db.prepare('SELECT * FROM authorized_senders WHERE email = ?').bind(email).first();
}
```

- [ ] **Step 3: Run to verify it passes**

Run: `node test/db.test.js`
Expected: `PASS`

- [ ] **Step 4: Commit**

```bash
git add expense-intake/src/db.js expense-intake/test/db.test.js
git commit -m "Add findAuthorizedSenderByEmail and logged_by_email support to db.js"
```

---

### Task 3: Onboarding — email-only authorized senders

**Files:**
- Modify: `expense-intake/src/onboarding.js`
- Modify: `expense-intake/test/onboarding.test.js`
- Modify: `expense-intake/README.md` (onboarding config example — done in Task 11, skip here)

Per your enrollment decision, email identity is added the same staff-run way phone numbers are: `onboard-client.js`'s config file gains an optional `email` per authorized sender, and `phoneNumber` becomes optional (each sender needs at least one). An email-only sender must never be blocked by the SMS consent gate.

- [ ] **Step 1: Write the failing tests**

Add these blocks to `expense-intake/test/onboarding.test.js`, right after the existing "a house missing googleSheetId is reported" block:

```javascript
  // validateConfig: an authorized sender with only an email (no phone) is valid — the actual compliance fix
  {
    const config = {
      businessName: 'Acme Rentals', twilioNumber: '+15559876543', accountingSoftware: 'quickbooks_online',
      houses: [{ address: '123 Main St', nickname: null, googleSheetId: 'sheet_abc' }],
      authorizedSenders: [{ email: 'owner@acme.com', label: null }],
    };
    let threw = false;
    try { validateConfig(config); } catch { threw = true; }
    assert(!threw, 'an authorized sender with only an email (no phone) must be valid');
  }

  // validateConfig: an authorized sender with neither phone nor email is reported
  {
    let threw = false;
    try {
      validateConfig({
        businessName: 'Acme Rentals', twilioNumber: '+15559876543', accountingSoftware: 'quickbooks_online',
        houses: [{ address: '123 Main St', nickname: null, googleSheetId: 'sheet_abc' }],
        authorizedSenders: [{ label: 'Nobody' }],
      });
    } catch (err) {
      threw = true;
      assert(err.message.includes('authorizedSenders[0]'), 'must report which authorized sender is missing both identities');
    }
    assert(threw, 'an authorized sender with neither phoneNumber nor email must throw');
  }
```

Add this block right after the existing `buildOnboardingSql` block:

```javascript
  // buildOnboardingSql: writes an authorized sender's email (lowercased) alongside/instead of a phone number
  {
    const config = {
      businessName: 'Acme Rentals', twilioNumber: '+15559876543', accountingSoftware: 'quickbooks_online',
      authorizedSenders: [{ email: 'Owner@Acme.com', label: 'Owner' }],
    };
    const sql = buildOnboardingSql(config, []);
    assert(sql.includes("'owner@acme.com'"), 'must lowercase the email before writing it');
    assert(/INSERT INTO authorized_senders \(client_id, phone_number, email, label\)/.test(sql), 'must include the email column in the authorized_senders INSERT');
    assert(sql.includes('NULL'), 'a missing phoneNumber must be written as SQL NULL');
  }
```

Add this block right after the existing `assertConsentForAuthorizedSenders` normalization block, before `console.log('PASS: onboarding.test.js');`:

```javascript
  // assertConsentForAuthorizedSenders: an email-only sender never touches the SMS consent gate at all
  {
    const config = { authorizedSenders: [{ email: 'owner@acme.com', label: null }] };
    let queryWasCalled = false;
    const queryConsentedPhones = async () => { queryWasCalled = true; return []; };
    let threw = false;
    try { await assertConsentForAuthorizedSenders(config, { queryConsentedPhones }); } catch { threw = true; }
    assert(!threw, 'an email-only authorized sender must never be blocked by the SMS consent gate');
    assert(!queryWasCalled, 'the SMS consent lookup must not even run when no authorized sender has a phone number');
  }
```

Run: `node test/onboarding.test.js`
Expected: FAIL (validateConfig doesn't yet accept email-only senders; buildOnboardingSql doesn't yet write an email column)

- [ ] **Step 2: Update `src/onboarding.js`**

Replace the `authorizedSenders` validation block inside `validateConfig`:

```javascript
  if (!Array.isArray(config.authorizedSenders) || config.authorizedSenders.length === 0) {
    errors.push('authorizedSenders must be a non-empty array');
  } else {
    config.authorizedSenders.forEach((sender, i) => {
      if (!sender.phoneNumber && !sender.email) errors.push(`authorizedSenders[${i}] must have a phoneNumber, an email, or both`);
    });
  }
```

Replace the `authorizedSenders` loop inside `buildOnboardingSql`:

```javascript
  for (const sender of config.authorizedSenders) {
    statements.push(
      `INSERT INTO authorized_senders (client_id, phone_number, email, label) VALUES (${clientIdSubquery}, ${sqlValue(sender.phoneNumber ?? null)}, ${sqlValue(sender.email ? sender.email.trim().toLowerCase() : null)}, ${sqlValue(sender.label ?? null)});`
    );
  }
```

Replace `assertConsentForAuthorizedSenders`:

```javascript
export async function assertConsentForAuthorizedSenders(config, deps) {
  const phoneNumbers = config.authorizedSenders
    .filter((sender) => sender.phoneNumber)
    .map((sender) => normalizePhoneNumber(sender.phoneNumber));
  if (phoneNumbers.length === 0) return;
  const consentedPhones = new Set(await deps.queryConsentedPhones(phoneNumbers));
  const missing = phoneNumbers.filter((phone) => !consentedPhones.has(phone));
  if (missing.length > 0) {
    throw new Error(`No SMS consent record found for: ${missing.join(', ')}. Each phone number must submit the /consent form before being onboarded.`);
  }
}
```

- [ ] **Step 3: Run to verify it passes**

Run: `node test/onboarding.test.js`
Expected: `PASS`

- [ ] **Step 4: Commit**

```bash
git add expense-intake/src/onboarding.js expense-intake/test/onboarding.test.js
git commit -m "Allow email-only authorized senders in onboarding config, skip SMS consent gate for them"
```

---

### Task 4: Install `postal-mime`

**Files:**
- Modify: `expense-intake/package.json`
- Modify: `expense-intake/package-lock.json` (generated)

- [ ] **Step 1: Install**

```bash
cd expense-intake
npm install postal-mime
```

- [ ] **Step 2: Verify**

Run: `node -e "import('postal-mime').then((m) => console.log(typeof m.default.parse))"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add expense-intake/package.json expense-intake/package-lock.json
git commit -m "Add postal-mime dependency for parsing inbound email"
```

---

### Task 5: `email-intake.js` — email-specific parsing helpers

**Files:**
- Create: `expense-intake/src/email-intake.js`
- Create: `expense-intake/test/email-intake.test.js`
- Modify: `expense-intake/test/run-all.js`

Pure/testable helpers: normalizing a from-address, extracting the receipt photo attachment, stripping quoted reply history so a clarification reply's text matches the shape `matchHouseFromReply` already expects, and parsing the raw MIME itself via `postal-mime`.

- [ ] **Step 1: Write the failing test**

```javascript
// expense-intake/test/email-intake.test.js
import {
  normalizeEmailAddress, stripQuotedReplyText, extractReceiptAttachment, parseInboundEmail,
} from '../src/email-intake.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function buildRawMime({ from, to, subject, messageId, textBody, attachmentBase64 }) {
  const boundary = 'BOUNDARY123';
  const headerLines = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`];
  if (messageId) headerLines.push(`Message-ID: ${messageId}`);
  headerLines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [...headerLines, '', `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', textBody, ''];
  if (attachmentBase64) {
    parts.push(
      `--${boundary}`,
      'Content-Type: image/jpeg; name="receipt.jpg"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="receipt.jpg"',
      '',
      attachmentBase64,
      ''
    );
  }
  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}

async function main() {
  // normalizeEmailAddress
  assert(normalizeEmailAddress('  Owner@Acme.com  ') === 'owner@acme.com', 'must trim and lowercase');
  assert(normalizeEmailAddress(undefined) === '', 'a non-string input must normalize to an empty string');

  // stripQuotedReplyText
  assert(
    stripQuotedReplyText('Main St\n\nOn Mon, Aug 25, 2026 at 9:00 AM Jane <jane@acme.com> wrote:\n> Which house is this for?') === 'Main St',
    'must cut at the "On ... wrote:" preamble'
  );
  assert(stripQuotedReplyText('Main St\n> Which house is this for?') === 'Main St', 'must cut at a ">" quote-marker line');
  assert(stripQuotedReplyText('Main St') === 'Main St', 'text with no quoted history must be returned unchanged (trimmed)');
  assert(stripQuotedReplyText(null) === '', 'a non-string input must normalize to an empty string');

  // extractReceiptAttachment
  {
    const found = extractReceiptAttachment([
      { mimeType: 'text/plain', content: new Uint8Array() },
      { mimeType: 'image/jpeg', content: new Uint8Array([1, 2, 3]) },
    ]);
    assert(found.contentType === 'image/jpeg' && found.bytes.length === 3, 'must find and return the first image attachment');
  }
  assert(extractReceiptAttachment([{ mimeType: 'text/plain', content: new Uint8Array() }]) === null, 'must return null when there is no image attachment');
  assert(extractReceiptAttachment([]) === null, 'must return null when there are no attachments at all');
  assert(extractReceiptAttachment(undefined) === null, 'must not throw when attachments is undefined');

  // parseInboundEmail: real MIME parsing via postal-mime, no fakes
  {
    const attachmentBytes = Buffer.from('fake-jpeg-bytes');
    const raw = buildRawMime({
      from: 'owner@acme.com', to: 'receipts@intake.venturesdatasolutions.com',
      subject: 'Receipt from Home Depot', messageId: '<abc123@acme.com>',
      textBody: "Here's a receipt.", attachmentBase64: attachmentBytes.toString('base64'),
    });
    const parsed = await parseInboundEmail(Buffer.from(raw, 'utf8'));
    assert(parsed.subject === 'Receipt from Home Depot', 'must extract the Subject header');
    assert(parsed.text.trim() === "Here's a receipt.", 'must extract the plain-text body');
    assert(parsed.messageId === '<abc123@acme.com>', 'must extract the Message-ID header');
    assert(parsed.attachments.length === 1, 'must extract the attachment');
    const attachment = extractReceiptAttachment(parsed.attachments);
    assert(attachment && attachment.contentType === 'image/jpeg', 'the parsed attachment must be recognized as an image');
    assert(Buffer.from(attachment.bytes).toString('utf8') === 'fake-jpeg-bytes', 'the attachment bytes must round-trip through base64 decoding correctly');
  }

  // parseInboundEmail: no attachment, no Message-ID
  {
    const raw = buildRawMime({
      from: 'owner@acme.com', to: 'receipts@intake.venturesdatasolutions.com',
      subject: 'Just a note', messageId: '', textBody: 'no attachment here',
    });
    const parsed = await parseInboundEmail(Buffer.from(raw, 'utf8'));
    assert(parsed.messageId === null, 'a missing Message-ID header must normalize to null, not undefined');
    assert(parsed.attachments.length === 0, 'a message with no attachment part must yield an empty attachments array');
  }

  console.log('PASS: email-intake.test.js');
}

await main();
```

Add to `expense-intake/test/run-all.js`, after `import './receipt-storage.test.js';`:
```javascript
import './email-intake.test.js';
```

Run: `node test/email-intake.test.js`
Expected: FAIL — `Cannot find module '../src/email-intake.js'`

- [ ] **Step 2: Implement `src/email-intake.js`**

```javascript
// expense-intake/src/email-intake.js
import PostalMime from 'postal-mime';

export function normalizeEmailAddress(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

const QUOTE_LINE_RE = /^>/;
const ON_WROTE_RE = /^On .+wrote:$/i;

// Strips quoted history from a reply email's plain-text body, so the clarification-reply
// text handed to matchHouseFromReply (src/providers/index.js) is just the new content — the
// same shape processExpenseMessage already expects for an SMS body. Cuts at the first line
// that looks like a quote marker or a client-generated "On ... wrote:" preamble; if no such
// line exists, the whole text is kept.
export function stripQuotedReplyText(text) {
  if (typeof text !== 'string') return '';
  const lines = text.split(/\r?\n/);
  const cutIndex = lines.findIndex((line) => QUOTE_LINE_RE.test(line.trim()) || ON_WROTE_RE.test(line.trim()));
  const kept = cutIndex === -1 ? lines : lines.slice(0, cutIndex);
  return kept.join('\n').trim();
}

// Only the first image attachment is treated as the receipt photo — same "first media item
// only" simplification src/twilio.js's extractWebhookFields already makes for MMS.
export function extractReceiptAttachment(attachments) {
  const image = (attachments || []).find((a) => typeof a.mimeType === 'string' && a.mimeType.startsWith('image/'));
  if (!image) return null;
  return { bytes: image.content, contentType: image.mimeType };
}

export async function parseInboundEmail(rawArrayBuffer) {
  const parsed = await PostalMime.parse(rawArrayBuffer);
  return {
    subject: parsed.subject || '',
    text: parsed.text || '',
    messageId: parsed.messageId || null,
    attachments: parsed.attachments || [],
  };
}

export const UNKNOWN_SENDER_REJECT_REASON =
  'This email address is not registered with VDS Expense Tracker. Contact hello@venturesdatasolutions.com to get set up.';
```

- [ ] **Step 3: Run to verify it passes**

Run: `node test/email-intake.test.js`
Expected: `PASS`

- [ ] **Step 4: Commit**

```bash
git add expense-intake/src/email-intake.js expense-intake/test/email-intake.test.js expense-intake/test/run-all.js
git commit -m "Add email-intake.js: MIME parsing, reply-quote stripping, attachment extraction"
```

---

### Task 6: `receipt-storage.js` — store a photo from raw bytes (no Twilio fetch)

**Files:**
- Modify: `expense-intake/src/receipt-storage.js`
- Modify: `expense-intake/test/receipt-storage.test.js`

The SMS path fetches media bytes from a Twilio URL before transforming/storing them. An email attachment's bytes are already inline in the parsed MIME — no fetch needed, but the same resize/recompress/R2-store logic applies.

- [ ] **Step 1: Write the failing test**

In `expense-intake/test/receipt-storage.test.js`, change the top import line from:
```javascript
import { generateReceiptKey, storeReceiptPhoto } from '../src/receipt-storage.js';
```
to:
```javascript
import { generateReceiptKey, storeReceiptPhoto, storeReceiptPhotoFromBytes } from '../src/receipt-storage.js';
```

Then add the following, right before the final `console.log('PASS: receipt-storage.test.js');`:

```javascript
  // storeReceiptPhotoFromBytes: happy path — no fetch, transforms via Images binding, stores to R2
  {
    const inputBytes = new Uint8Array([9, 9, 9]);
    const jpegBytes2 = new ArrayBuffer(4);
    const imagesBinding = createFakeImagesBinding(jpegBytes2);
    const bucket = createFakeR2Bucket();
    const resultKey = await storeReceiptPhotoFromBytes({
      bytes: inputBytes,
      imagesBinding,
      bucket,
      key: 'receipts/email/1.jpg',
    });
    assert(resultKey === 'receipts/email/1.jpg', 'storeReceiptPhotoFromBytes must return the key it was given');
    assert(imagesBinding.calls[0].source === inputBytes, 'must pass the given bytes directly into the Images binding, with no fetch');
    assert(imagesBinding.calls[0].transformOptions.width === 1568 && imagesBinding.calls[0].transformOptions.height === 1568, 'must cap both dimensions at 1568px, same as the SMS path');
    assert(imagesBinding.calls[0].outputOptions.format === 'image/jpeg' && imagesBinding.calls[0].outputOptions.quality === 85, 'must re-encode as JPEG at quality 85, same as the SMS path');
    const stored = bucket._store.get('receipts/email/1.jpg');
    assert(stored.value === jpegBytes2, 'must store the transformed JPEG bytes in R2 under the given key');
    assert(stored.options.httpMetadata.contentType === 'image/jpeg', 'must set the R2 object content type to image/jpeg');
  }

  // storeReceiptPhotoFromBytes: Images binding failure must propagate, not be swallowed
  {
    const throwingImagesBinding = {
      input() {
        return { transform() { return this; }, async output() { throw new Error('Images transform failed: unsupported format'); } };
      },
    };
    let threw = false;
    try {
      await storeReceiptPhotoFromBytes({ bytes: new Uint8Array([1]), imagesBinding: throwingImagesBinding, bucket: createFakeR2Bucket(), key: 'receipts/email/2.jpg' });
    } catch (err) {
      threw = true;
      assert(/Images transform failed/.test(err.message), 'the Images binding error must propagate unchanged');
    }
    assert(threw, 'an Images binding failure must throw rather than silently storing nothing');
  }
```

Run: `node test/receipt-storage.test.js`
Expected: FAIL — `storeReceiptPhotoFromBytes is not a function`

- [ ] **Step 2: Implement in `src/receipt-storage.js`**

Add after the existing `storeReceiptPhoto` function (reuses the module's existing `MAX_DIMENSION`/`JPEG_QUALITY` constants):

```javascript
// Sibling to storeReceiptPhoto, for a channel where the bytes are already in hand (an email
// attachment parsed via postal-mime) instead of needing a fetch from a Twilio media URL. Same
// resize/recompress/store pipeline either way.
//
// NOTE: the real Cloudflare Images binding has no local emulation (see the README's existing
// caveat) — confirm `.input()` accepts a Uint8Array directly during the first
// `wrangler dev --remote` smoke test of the email path; wrap in `new Response(bytes).body` here
// if it turns out to require a ReadableStream instead.
export async function storeReceiptPhotoFromBytes({ bytes, imagesBinding, bucket, key }) {
  const transformed = await imagesBinding
    .input(bytes)
    .transform({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'scale-down' })
    .output({ format: 'image/jpeg', quality: JPEG_QUALITY });
  const jpegBytes = await transformed.response().arrayBuffer();
  await bucket.put(key, jpegBytes, { httpMetadata: { contentType: 'image/jpeg' } });
  return key;
}
```

- [ ] **Step 3: Run to verify it passes**

Run: `node test/receipt-storage.test.js`
Expected: `PASS`

- [ ] **Step 4: Commit**

```bash
git add expense-intake/src/receipt-storage.js expense-intake/test/receipt-storage.test.js
git commit -m "Add storeReceiptPhotoFromBytes for email attachments"
```

---

### Task 7: `expense-flow.js` — extract shared core, channel-aware `fileExpense`

**Files:**
- Modify: `expense-intake/src/expense-flow.js`

This is a refactor of already-shipped, tested code: `processExpenseMessage`'s body from the houses-lookup onward is extracted into an exported `processResolvedExpenseMessage`, so the email handler (Task 8) can call it directly after doing its own (email-specific) sender resolution. `processExpenseMessage`'s external behavior must not change — the entire existing `expense-flow.test.js` suite (28 scenarios) must keep passing unmodified.

- [ ] **Step 1: Confirm the baseline is green**

Run: `node test/expense-flow.test.js`
Expected: `PASS` (before touching anything — this is your regression baseline)

- [ ] **Step 2: Extract the core function**

In `expense-intake/src/expense-flow.js`, replace the existing `processExpenseMessage` function (currently the last function in the file) with:

```javascript
export async function processExpenseMessage({ fields, photoR2Key, env, deps = {} }) {
  if (!fields.body && !photoR2Key) {
    return { smsBody: '' };
  }

  const client = await findClientByTwilioNumber(env.DB, fields.to);
  if (!client) {
    return { smsBody: '' };
  }

  const sender = await findAuthorizedSender(env.DB, client.id, fields.from);
  if (!sender) {
    return { smsBody: '' };
  }

  await maybeSendContactCard({ client, sender, fields, env, deps });

  return processResolvedExpenseMessage({ client, fields, photoR2Key, env, deps });
}

// Shared by both channels once a client has been resolved: SMS resolves it via the Twilio "To"
// number (above); the email handler (src/handlers.js's handleEmailWebhook) resolves it via the
// sender's email address instead, since a single shared inbox has no per-client "To" signal.
// Everything from here on — house lookup, the pending-queue/house-selection/correction-window
// checks, parsing/categorizing, and filing — is identical for both channels.
export async function processResolvedExpenseMessage({ client, fields, photoR2Key, env, deps = {} }) {
  const houses = await findHousesForClient(env.DB, client.id);

  // A reply's text is checked against the pending-review queue command/cursor, then any
  // in-flight house-selection prompt or open correction window, before it's treated as a
  // brand-new expense message. A photo-only message (no body text) has nothing to match
  // against a house name or command keyword, so it always skips straight to normal
  // processing — same as Step 4's existing empty-body-for-text handling.
  if (fields.body) {
    const normalizedBody = fields.body.trim().toLowerCase();

    if (normalizedBody === 'pending') {
      const smsBody = await handlePendingCommand({ client, fields, env, deps });
      return { smsBody };
    }

    const pendingQueueState = await getPendingQueueState(env.CONVERSATION_STATE, fields.from);
    if (pendingQueueState) {
      const queueSmsBody = await handlePendingQueueReply({ state: pendingQueueState, client, houses, fields, env, deps });
      if (queueSmsBody !== null) {
        return { smsBody: queueSmsBody };
      }
      // Not a recognized queue action — fall through and process it as a new message below.
    }

    const awaitingHouse = await getAwaitingHouse(env.CONVERSATION_STATE, fields.from);
    if (awaitingHouse) {
      const smsBody = await handleAwaitingHouseReply({ state: awaitingHouse, houses, fields, env, deps });
      return { smsBody };
    }

    const correctionState = await getCorrectionState(env.CONVERSATION_STATE, fields.from);
    if (correctionState) {
      const correctionSmsBody = await tryApplyCorrection({ state: correctionState, houses, fields, env, deps });
      if (correctionSmsBody !== null) {
        return { smsBody: correctionSmsBody };
      }
      // Not a correction after all — fall through and process it as a new message below.
    }
  }

  const image = photoR2Key ? await loadStoredPhotoAsImageInput(env.RECEIPTS_BUCKET, photoR2Key) : null;

  let parsed = null;
  try {
    parsed = await parseExpense({ text: fields.body || null, image }, env, deps);
  } catch (err) {
    console.error('parseExpense failed', { error: err.message });
    parsed = null;
  }

  const houseIsAmbiguous = houses.length !== 1;

  if (houseIsAmbiguous) {
    const pendingReviewId = await insertPendingReview(env.DB, {
      clientId: client.id,
      houseId: null,
      amountGuess: parsed ? parsed.amount : null,
      categoryGuess: parsed ? parsed.category : null,
      photoR2Key,
      rawText: parsed ? parsed.raw_text : (fields.body || ''),
      confidence: parsed ? parsed.confidence : 0,
      expiresAt: pendingReviewExpiresAt(),
    });
    await setAwaitingHouse(env.CONVERSATION_STATE, fields.from, { pendingReviewId, attempt: 0 });
    const smsBody = await safeGenerateSmsCopy('house_selection', {}, env, deps);
    return { smsBody };
  }

  const house = houses[0];

  if (parsed && parsed.confidence >= CONFIDENCE_THRESHOLD && parsed.amount != null) {
    const smsBody = await fileExpense({ house, parsed, fields, photoR2Key, env, deps });
    return { smsBody };
  }

  await insertPendingReview(env.DB, {
    clientId: client.id,
    houseId: house.id,
    amountGuess: parsed ? parsed.amount : null,
    categoryGuess: parsed ? parsed.category : null,
    photoR2Key,
    rawText: parsed ? parsed.raw_text : (fields.body || ''),
    confidence: parsed ? parsed.confidence : 0,
    expiresAt: pendingReviewExpiresAt(),
  });
  const smsBody = await safeGenerateSmsCopy('low_confidence', {
    category: parsed ? parsed.category : 'Uncategorized',
  }, env, deps);
  return { smsBody };
}
```

- [ ] **Step 3: Run the full existing suite to confirm zero regressions**

Run: `node test/expense-flow.test.js`
Expected: `PASS` — all 28 existing scenarios still pass unmodified, since `processExpenseMessage`'s signature and behavior are unchanged.

- [ ] **Step 4: Write the failing test for channel-aware `fileExpense`**

Add to `expense-intake/test/expense-flow.test.js`, right after scenario 1 ("Happy path: single house, high confidence, photo message"):

```javascript
  // 1b. processResolvedExpenseMessage (email channel): high confidence, single house -> files
  // under logged_by_email, not logged_by_phone, and never touches sms_consents/phone state
  {
    const db = createFakeD1({
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.9, raw_text: 'HD $42.50' }),
        'Logged: $42.50, Materials, Main St.'
      )],
    ]);
    const { processResolvedExpenseMessage } = await import('../src/expense-flow.js');
    const result = await processResolvedExpenseMessage({
      client,
      fields: { from: 'owner@acme.com', to: 'receipts@intake.venturesdatasolutions.com', body: '', channel: 'email' },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'an email-channel high-confidence match must produce a confirmation body');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert, 'an email-channel match must insert an expenses row');
    assert(expenseInsert.params[8] === null, 'logged_by_phone must be null for an email-channel expense');
    assert(expenseInsert.params[9] === 'owner@acme.com', 'logged_by_email must carry the sender email for an email-channel expense');
  }
```

Replace the existing top-level import line:

Before:
```javascript
import { processExpenseMessage } from '../src/expense-flow.js';
```

After:
```javascript
import { processExpenseMessage, processResolvedExpenseMessage } from '../src/expense-flow.js';
```

Then remove the redundant inline `const { processResolvedExpenseMessage } = await import('../src/expense-flow.js');` line from the scenario above and just call `processResolvedExpenseMessage` directly (it's now imported at the top like everything else).

Run: `node test/expense-flow.test.js`
Expected: FAIL — `expenseInsert.params[9]` is `undefined`/wrong (fileExpense doesn't yet branch on channel)

- [ ] **Step 5: Make `fileExpense` channel-aware**

In `expense-intake/src/expense-flow.js`, replace the `insertExpense` call inside `fileExpense`:

```javascript
  const isEmailChannel = fields.channel === 'email';
  const expenseId = await insertExpense(env.DB, {
    houseId: house.id,
    date: todayIso(),
    vendor: parsed.vendor,
    amount: parsed.amount,
    category: parsed.category,
    confidence: parsed.confidence,
    photoR2Key,
    rawText: parsed.raw_text,
    loggedByPhone: isEmailChannel ? null : fields.from,
    loggedByEmail: isEmailChannel ? fields.from : null,
    notes: '',
    sheetRow,
  });
```

(`fields.channel` is simply absent for every existing SMS call site, so `isEmailChannel` is `false` and behavior for SMS is byte-for-byte unchanged.)

- [ ] **Step 6: Run to verify it passes**

Run: `node test/expense-flow.test.js`
Expected: `PASS` — all 29 scenarios (28 original + the new email one)

- [ ] **Step 7: Commit**

```bash
git add expense-intake/src/expense-flow.js expense-intake/test/expense-flow.test.js
git commit -m "Extract processResolvedExpenseMessage core, make fileExpense channel-aware"
```

---

### Task 8: `handlers.js` — `handleEmailWebhook`

**Files:**
- Modify: `expense-intake/src/handlers.js`
- Create: `expense-intake/test/fake-email-message.js`
- Create: `expense-intake/test/fake-email-send.js`
- Create: `expense-intake/test/email-handlers.test.js`
- Modify: `expense-intake/test/run-all.js`

This is the orchestration: parse the raw MIME, resolve the sender by email (rejecting *before* storing any attachment, so an unrecognized/spam sender never causes an R2 write), store the photo if present, run it through `processResolvedExpenseMessage`, and reply via the `send_email` binding with threading headers. Kept in its own test file (rather than folded into the existing shallow `handlers.test.js`) because — like `expense-flow.test.js` versus `handlers.test.js` for SMS — this needs the full AI/Sheets mocking stack to prove the end-to-end round trip, not just webhook plumbing.

- [ ] **Step 1: Create the test fakes**

```javascript
// expense-intake/test/fake-email-message.js
// Mimics the shape of Cloudflare's ForwardableEmailMessage closely enough to test the
// email() handler's wiring: from/to, a single-use raw ReadableStream, and a spy-able
// setReject. There is no local emulation for real inbound email (same category of gap
// already documented for the Images binding in receipt-storage.js).
export function createFakeEmailMessage({ from, to, raw }) {
  const rejections = [];
  return {
    from,
    to,
    raw: new Response(raw).body,
    setReject(reason) {
      rejections.push(reason);
    },
    _rejections: rejections,
  };
}
```

```javascript
// expense-intake/test/fake-email-send.js
export function createFakeEmailSender() {
  const calls = [];
  return {
    async send(options) {
      calls.push(options);
      return { id: `fake-email-${calls.length}` };
    },
    calls,
  };
}
```

- [ ] **Step 2: Write the failing tests**

```javascript
// expense-intake/test/email-handlers.test.js
import crypto from 'node:crypto';
import { handleEmailWebhook } from '../src/handlers.js';
import { createFakeD1 } from './fake-d1.js';
import { createFakeR2Bucket } from './fake-r2.js';
import { createFakeImagesBinding } from './fake-images.js';
import { createFakeKV } from './fake-kv.js';
import { createFakeEmailMessage } from './fake-email-message.js';
import { createFakeEmailSender } from './fake-email-send.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function generateTestServiceAccount() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { client_email: 'test-sa@test.iam.gserviceaccount.com', private_key: privateKey };
}

function chatResponse(content) {
  return { choices: [{ message: { content } }] };
}

function dispatchFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    for (const [match, respond] of handlers) {
      if (url.includes(match)) return respond(url, init);
    }
    throw new Error(`Unhandled fetch in test: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function jsonOk(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

function openRouterRouter({ parse, match, copy }) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    let content = copy;
    if (typeof system === 'string' && system.includes('expense-parsing assistant')) content = parse;
    else if (typeof system === 'string' && system.includes('matching a text reply')) content = match;
    return { ok: true, status: 200, json: async () => chatResponse(content) };
  };
}

function buildRawMime({ from, to, subject, messageId, textBody, attachmentBase64 }) {
  const boundary = 'BOUNDARY123';
  const headerLines = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`];
  if (messageId) headerLines.push(`Message-ID: ${messageId}`);
  headerLines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [...headerLines, '', `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', textBody, ''];
  if (attachmentBase64) {
    parts.push(
      `--${boundary}`, 'Content-Type: image/jpeg; name="receipt.jpg"', 'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="receipt.jpg"', '', attachmentBase64, ''
    );
  }
  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}

function baseEnv(db, overrides = {}) {
  return {
    DB: db,
    RECEIPTS_BUCKET: createFakeR2Bucket(),
    IMAGES: createFakeImagesBinding(new ArrayBuffer(4)),
    CONVERSATION_STATE: createFakeKV(),
    AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'or_key',
    GOOGLE_SERVICE_ACCOUNT_JSON: generateTestServiceAccount(),
    WORKER_BASE_URL: 'https://expense-intake.example.workers.dev',
    RECEIPTS_EMAIL_ADDRESS: 'receipts@intake.venturesdatasolutions.com',
    EMAIL: createFakeEmailSender(),
    ...overrides,
  };
}

async function main() {
  const client = { id: 1, business_name: 'Acme Rentals', twilio_number: '+15559876543' };
  const singleHouse = [{ id: 10, client_id: 1, address: '123 Main St', nickname: 'Main St', google_sheet_id: 'sheet_abc' }];
  const twoHouses = [
    singleHouse[0],
    { id: 11, client_id: 1, address: '456 Oak Ave', nickname: 'Oak Ave', google_sheet_id: 'sheet_def' },
  ];

  // 1. Valid receipt email, with a photo attachment, from a recognized EMAIL-ONLY sender
  // (phone_number null, no sms_consents row exists anywhere in this fake DB) -> logs the
  // expense under logged_by_email and sends a confirmation reply. This is also the proof
  // that the flow works fully independent of any SMS opt-in state.
  {
    const db = createFakeD1({
      'SELECT * FROM authorized_senders WHERE email = ?': { id: 7, client_id: 1, phone_number: null, email: 'owner@acme.com' },
      'SELECT * FROM clients WHERE id = ?': client,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const emailSender = createFakeEmailSender();
    const env = baseEnv(db, { EMAIL: emailSender });
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterRouter({
        parse: JSON.stringify({ vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.9, raw_text: 'HD $42.50' }),
        copy: 'Logged: $42.50, Materials, Main St.',
      })],
    ]);
    const raw = buildRawMime({
      from: 'owner@acme.com', to: 'receipts@intake.venturesdatasolutions.com',
      subject: 'Receipt', messageId: '<msg1@acme.com>', textBody: 'Home Depot receipt attached',
      attachmentBase64: Buffer.from('fake-jpeg-bytes').toString('base64'),
    });
    const message = createFakeEmailMessage({ from: 'owner@acme.com', to: 'receipts@intake.venturesdatasolutions.com', raw });
    const result = await handleEmailWebhook({ message, env, deps: { fetchImpl } });

    assert(result.status === 'sent', 'a valid receipt email from a recognized sender must be processed and replied to');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert, 'a valid receipt email must insert an expenses row');
    assert(expenseInsert.params[8] === null && expenseInsert.params[9] === 'owner@acme.com', 'the expense must be logged under logged_by_email, not logged_by_phone');
    assert(!db.calls.some((c) => c.sql.includes('sms_consents')), 'the flow must never query sms_consents for an email-only sender — proves it is independent of any SMS opt-in state');
    assert(emailSender.calls.length === 1 && emailSender.calls[0].to === 'owner@acme.com', 'a confirmation reply must be sent back to the sender');
    assert(emailSender.calls[0].headers && emailSender.calls[0].headers['In-Reply-To'] === '<msg1@acme.com>', 'the reply must thread via In-Reply-To when the inbound message has a Message-ID');
  }

  // 2. Unrecognized sender -> rejected, no D1 writes, no reply sent
  {
    const db = createFakeD1({ 'SELECT * FROM authorized_senders WHERE email = ?': null });
    const emailSender = createFakeEmailSender();
    const env = baseEnv(db, { EMAIL: emailSender });
    const raw = buildRawMime({
      from: 'stranger@example.com', to: 'receipts@intake.venturesdatasolutions.com',
      subject: 'Receipt', messageId: '<msg2@example.com>', textBody: 'some text',
    });
    const message = createFakeEmailMessage({ from: 'stranger@example.com', to: 'receipts@intake.venturesdatasolutions.com', raw });
    const result = await handleEmailWebhook({ message, env, deps: {} });

    assert(result.status === 'rejected', 'an email from an unrecognized address must be rejected');
    assert(message._rejections.length === 1, 'setReject must be called exactly once for an unrecognized sender');
    assert(!db.calls.some((c) => c.sql.includes('INSERT')), 'no writes of any kind must happen for an unrecognized sender');
    assert(emailSender.calls.length === 0, 'no reply must be sent for an unrecognized sender');
  }

  // 3. Ambiguous house -> clarification reply sent; a follow-up email from the same address
  // (matched by KV state, not by reply-threading headers) resolves it and files the expense
  {
    const db = createFakeD1({
      'SELECT * FROM authorized_senders WHERE email = ?': { id: 8, client_id: 1, phone_number: null, email: 'multi@acme.com' },
      'SELECT * FROM clients WHERE id = ?': client,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
    });
    const kv = createFakeKV();
    const emailSender = createFakeEmailSender();
    const env = baseEnv(db, { CONVERSATION_STATE: kv, EMAIL: emailSender });

    const firstFetch = dispatchFetch([
      ['openrouter.ai', openRouterRouter({
        parse: JSON.stringify({ vendor: 'Lowes', amount: 10, category: 'Materials', confidence: 0.95, raw_text: 'Lowes $10' }),
        copy: 'Which house is this for?',
      })],
    ]);
    const firstRaw = buildRawMime({
      from: 'multi@acme.com', to: 'receipts@intake.venturesdatasolutions.com',
      subject: 'Receipt', messageId: '<msg3@acme.com>', textBody: 'Lowes $10',
    });
    const firstMessage = createFakeEmailMessage({ from: 'multi@acme.com', to: 'receipts@intake.venturesdatasolutions.com', raw: firstRaw });
    const firstResult = await handleEmailWebhook({ message: firstMessage, env, deps: { fetchImpl: firstFetch } });

    assert(firstResult.status === 'sent', 'an ambiguous house must still produce a clarification reply, not a rejection');
    assert(emailSender.calls.length === 1, 'the first (ambiguous) email must trigger exactly one clarification reply');
    const awaitingHouseCall = kv.calls.find((c) => c.method === 'put' && c.key === 'awaiting_house:multi@acme.com');
    assert(awaitingHouseCall, 'an ambiguous house must open an awaiting_house KV state keyed by the sender EMAIL address');
    assert(!db.calls.some((c) => c.sql.includes('INSERT INTO expenses')), 'an ambiguous house must not file anything yet');

    const secondFetch = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_def', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterRouter({ match: JSON.stringify({ house_id: 11 }), copy: 'Logged: $10.00, Materials, Oak Ave.' })],
    ]);
    const secondRaw = buildRawMime({
      from: 'multi@acme.com', to: 'receipts@intake.venturesdatasolutions.com',
      subject: 'Re: Receipt', messageId: '<msg4@acme.com>',
      textBody: 'Oak Ave\n\nOn Mon wrote:\n> Which house is this for?',
    });
    const secondMessage = createFakeEmailMessage({ from: 'multi@acme.com', to: 'receipts@intake.venturesdatasolutions.com', raw: secondRaw });
    const secondResult = await handleEmailWebhook({ message: secondMessage, env, deps: { fetchImpl: secondFetch } });

    assert(secondResult.status === 'sent', 'the follow-up reply must resolve the ambiguous house');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert && expenseInsert.params[0] === 11, 'the follow-up reply must file the expense under the house it named (Oak Ave, house_id 11)');
  }

  console.log('PASS: email-handlers.test.js');
}

await main();
```

Add to `expense-intake/test/run-all.js`, after `import './handlers.test.js';`:
```javascript
import './email-handlers.test.js';
```

Run: `node test/email-handlers.test.js`
Expected: FAIL — `handleEmailWebhook is not a function`

- [ ] **Step 3: Implement `handleEmailWebhook` in `src/handlers.js`**

`generateReceiptKey` and `findClientById` are already imported (from `receipt-storage.js` and `db.js` respectively) — extend those two existing import lines rather than duplicating them, and add one new import line for `email-intake.js`:

Before:
```javascript
import { generateReceiptKey, storeReceiptPhoto } from './receipt-storage.js';
import { processExpenseMessage } from './expense-flow.js';
```
```javascript
import { findClientById, insertSmsConsent } from './db.js';
```

After:
```javascript
import { generateReceiptKey, storeReceiptPhoto, storeReceiptPhotoFromBytes } from './receipt-storage.js';
import { processExpenseMessage, processResolvedExpenseMessage } from './expense-flow.js';
```
```javascript
import { findClientById, findAuthorizedSenderByEmail, insertSmsConsent } from './db.js';
```

Add this new import line (anywhere among the others):
```javascript
import { parseInboundEmail, extractReceiptAttachment, stripQuotedReplyText, normalizeEmailAddress, UNKNOWN_SENDER_REJECT_REASON } from './email-intake.js';
```

Add this function to `expense-intake/src/handlers.js`:

```javascript
function escapeEmailHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Cloudflare Email Routing's email() handler for receipts@<subdomain> — see src/index.js.
// Unlike Twilio's signature-verified webhook, there's no HMAC to check on inbound email; the
// sender-address lookup against authorized_senders.email IS the trust boundary here, which is
// why it happens before anything else (including photo storage) below.
export async function handleEmailWebhook({ message, env, deps = {} }) {
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parsed = await parseInboundEmail(rawBuffer);
  const fromAddress = normalizeEmailAddress(message.from);

  const sender = await findAuthorizedSenderByEmail(env.DB, fromAddress);
  if (!sender) {
    message.setReject(UNKNOWN_SENDER_REJECT_REASON);
    return { status: 'rejected', reason: 'unrecognized_sender' };
  }
  const client = await findClientById(env.DB, sender.client_id);
  if (!client) {
    message.setReject(UNKNOWN_SENDER_REJECT_REASON);
    return { status: 'rejected', reason: 'unrecognized_sender' };
  }

  let photoR2Key = null;
  const attachment = extractReceiptAttachment(parsed.attachments);
  if (attachment) {
    photoR2Key = generateReceiptKey(fromAddress);
    try {
      await storeReceiptPhotoFromBytes({
        bytes: attachment.bytes,
        imagesBinding: env.IMAGES,
        bucket: env.RECEIPTS_BUCKET,
        key: photoR2Key,
      });
    } catch (err) {
      console.error('Failed to store receipt photo from email', { error: err.message });
      return { status: 'error', reason: 'photo_storage_failed' };
    }
  }

  const fields = {
    from: fromAddress,
    to: message.to,
    body: stripQuotedReplyText(parsed.text),
    channel: 'email',
  };

  let smsBody;
  try {
    ({ smsBody } = await processResolvedExpenseMessage({ client, fields, photoR2Key, env, deps }));
  } catch (err) {
    console.error('Failed to process email expense message', { error: err.message });
    return { status: 'error', reason: 'processing_failed' };
  }

  if (!smsBody) {
    return { status: 'ignored' };
  }

  try {
    await env.EMAIL.send({
      to: fromAddress,
      from: env.RECEIPTS_EMAIL_ADDRESS,
      subject: `Re: ${parsed.subject || 'Your receipt'}`,
      text: smsBody,
      html: `<p>${escapeEmailHtml(smsBody)}</p>`,
      ...(parsed.messageId ? { headers: { 'In-Reply-To': parsed.messageId, References: parsed.messageId } } : {}),
    });
  } catch (err) {
    // A send failure here happens after the expense has already been logged to Sheets/D1 —
    // never let it propagate and look like the whole request failed (same reasoning as
    // safeGenerateSmsCopy's fallback path for the SMS side).
    console.error('Failed to send email confirmation reply', { error: err.message });
  }

  return { status: 'sent', replyBody: smsBody };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test/email-handlers.test.js`
Expected: `PASS`

- [ ] **Step 5: Run the full suite**

Run: `node test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [ ] **Step 6: Commit**

```bash
git add expense-intake/src/handlers.js expense-intake/test/fake-email-message.js expense-intake/test/fake-email-send.js expense-intake/test/email-handlers.test.js expense-intake/test/run-all.js
git commit -m "Add handleEmailWebhook: resolve sender by email, file expense, reply with threading"
```

---

### Task 9: Wire up the `email()` handler and `send_email` binding

**Files:**
- Modify: `expense-intake/src/index.js`
- Modify: `expense-intake/wrangler.toml`
- Modify: `expense-intake/test/index.test.js`

- [ ] **Step 1: Write the failing test**

Add to `expense-intake/test/index.test.js`, right before `console.log('PASS: index.test.js');`. This requires importing the same fakes Task 8 added:

```javascript
import { createFakeEmailMessage } from './fake-email-message.js';
import { createFakeEmailSender } from './fake-email-send.js';
```

(add these two imports at the top of the file, alongside the existing fake imports)

```javascript
  // email(): the real Worker export routes an inbound email to handleEmailWebhook — an
  // unrecognized sender is rejected through the real handler, not just the unit-tested one
  {
    const emailDb = createFakeD1({ 'SELECT * FROM authorized_senders WHERE email = ?': null });
    const emailSender = createFakeEmailSender();
    const rawMime = [
      'From: stranger@example.com',
      'To: receipts@intake.venturesdatasolutions.com',
      'Subject: Receipt',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'some text',
    ].join('\r\n');
    const message = createFakeEmailMessage({ from: 'stranger@example.com', to: 'receipts@intake.venturesdatasolutions.com', raw: rawMime });
    await workerModule.email(message, baseEnv({ DB: emailDb, EMAIL: emailSender }));
    assert(message._rejections.length === 1, 'the real email() export must reject an unrecognized sender through the real handler');
  }
```

Run: `node test/index.test.js`
Expected: FAIL — `workerModule.email is not a function`

- [ ] **Step 2: Update `src/index.js`**

Update the import line at the top:

```javascript
import { handleSmsWebhook, handleGetReceipt, handleGetContactCard, handleGetConsentForm, handlePostConsent, handleEmailWebhook } from './handlers.js';
```

Add the `email` export alongside `fetch` and `scheduled`:

```javascript
  async email(message, env) {
    await handleEmailWebhook({ message, env });
  },
```

- [ ] **Step 3: Update `wrangler.toml`**

Add a `RECEIPTS_EMAIL_ADDRESS` line to the existing `[vars]` block:

```toml
[vars]
AI_PROVIDER = "openrouter"
WORKER_BASE_URL = "https://expense-intake.venturesdatasolutions.workers.dev"
RECEIPTS_EMAIL_ADDRESS = "receipts@intake.venturesdatasolutions.com"
```

Add a new `send_email` binding block (anywhere after `[vars]`, e.g. right after the `[[r2_buckets]]` block):

```toml
[[send_email]]
name = "EMAIL"
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test/index.test.js`
Expected: `PASS`

- [ ] **Step 5: Run the full suite**

Run: `node test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [ ] **Step 6: Commit**

```bash
git add expense-intake/src/index.js expense-intake/wrangler.toml expense-intake/test/index.test.js
git commit -m "Wire up email() handler export and send_email binding"
```

---

### Task 10: Docs — README, onboarding config, marketing copy, privacy policy

**Files:**
- Modify: `expense-intake/README.md`
- Modify: `platform.html`
- Modify: `investors.html`
- Modify: `privacy.html`

- [ ] **Step 1: `expense-intake/README.md` — new "Email handler" section**

Add a new section right after the existing `## Routes` section (after the `- **Cron Triggers**...` bullet block):

```markdown
## Email handler

`email()` — Cloudflare Email Routing delivers inbound mail sent to
`receipts@intake.venturesdatasolutions.com` to this Worker (no HTTP route
involved). The handler parses the raw MIME (via `postal-mime`), resolves the
sender by matching their From address against `authorized_senders.email`,
and — if recognized — runs it through the exact same parse/categorize/
house-matching/Sheet-filing pipeline SMS uses (`processResolvedExpenseMessage`
in `src/expense-flow.js`), then replies via the `send_email` binding.

An unrecognized sender is rejected outright (`message.setReject(...)`, a real
SMTP-level rejection) rather than silently dropped — there's no signature
equivalent to Twilio's `X-Twilio-Signature` for inbound email, so this
sender-address lookup **is** the trust boundary. A clarification reply (e.g.
"which property is this for?") is matched back to the original message purely
by sender address + the same `CONVERSATION_STATE` KV state SMS already uses
(`awaiting_house:<email>` etc.), not by parsing `In-Reply-To`/`References` —
more robust against mail clients that don't preserve threading headers on
reply. Our own replies still set those headers so the thread displays
correctly in the subscriber's inbox.

This channel exists specifically so a subscriber can use the product without
ever opting into SMS — see
`docs/superpowers/specs/2026-08-25-expense-intake-email-channel-design.md`.
An authorized sender can have an `email`, a `phone_number`, or both; only a
sender with a phone number is ever gated behind the `/consent` SMS opt-in
flow.
```

- [ ] **Step 2: `expense-intake/README.md` — onboarding config example**

In the existing "Onboarding a new client" section, replace the `authorizedSenders` line in the example JSON:

Before:
```json
  "authorizedSenders": [
    { "phoneNumber": "+15551234567", "label": "Owner" }
  ]
```

After:
```json
  "authorizedSenders": [
    { "phoneNumber": "+15551234567", "label": "Owner" },
    { "email": "owner@acme.com", "label": "Owner (email-only, no SMS)" }
  ]
```

Add a sentence right after the existing paragraph that starts with "`accountingSoftware` must be one of...":

```markdown
Each authorized sender needs a `phoneNumber`, an `email`, or both — an
email-only sender is never subject to the `/consent` SMS opt-in check
(`assertConsentForAuthorizedSenders` in `src/onboarding.js` only validates
consent for senders that actually have a phone number).
```

- [ ] **Step 3: `expense-intake/README.md` — one-time Email Routing/Sending setup**

Add a new section after the existing "## Twilio secrets" section:

```markdown
## Email Routing / Sending setup (one-time, per environment)

```bash
npx wrangler email routing enable intake.venturesdatasolutions.com
npx wrangler email sending enable intake.venturesdatasolutions.com
```

A dedicated subdomain, not the apex `venturesdatasolutions.com` — `hello@`/
`sales@venturesdatasolutions.com` are live mailboxes today on a separate,
unconfirmed provider, and a subdomain has its own independent MX records, so
this is fully additive with zero risk to that existing mail.

Then create a routing rule sending `receipts@intake.venturesdatasolutions.com`
to this Worker (Dashboard → Email Routing → Routing Rules, or
`wrangler email routing rules create`) — this is the step that actually
connects the address to the `email()` handler; the two `enable` commands
above only turn on Email Routing/Sending for the subdomain.
```

- [ ] **Step 4: `platform.html` — marketing copy**

In `platform.html`, replace:

```html
          <p>Text or photo an expense and it&rsquo;s routed to the right property&rsquo;s job-cost sheet automatically, with tax categories rolled up for you. Higher tiers add property research pulling public records, comps cross-referenced against your own job-cost history, and full document handling.</p>
```

with:

```html
          <p>Text, email, or photo an expense and it&rsquo;s routed to the right property&rsquo;s job-cost sheet automatically, with tax categories rolled up for you. Higher tiers add property research pulling public records, comps cross-referenced against your own job-cost history, and full document handling.</p>
```

- [ ] **Step 5: `investors.html` — marketing copy**

In `investors.html`, replace:

```html
    <p class="lede">Text or photo a receipt and it lands in the right property&rsquo;s job-cost sheet, tax category included. As you scale, add property research and document handling that keeps pace with however many houses you&rsquo;re running at once.</p>
```

with:

```html
    <p class="lede">Text, email, or photo a receipt and it lands in the right property&rsquo;s job-cost sheet, tax category included. As you scale, add property research and document handling that keeps pace with however many houses you&rsquo;re running at once.</p>
```

- [ ] **Step 6: `privacy.html` — disclose the email intake channel**

In `privacy.html`, in "8. SMS/Text Messaging", add a new paragraph right after the existing paragraph that ends "...Message and data rates may apply." (before the "We do not share, sell..." paragraph):

```html
    <p>If you submit an expense receipt by email instead of by text (to <a href="mailto:receipts@intake.venturesdatasolutions.com">receipts@intake.venturesdatasolutions.com</a>), we collect and use your email address for that same expense-logging purpose &mdash; for example, expense confirmations and requests to identify which property an expense belongs to. Using email in place of text messages is fully supported and is never required to also opt in to SMS, or vice versa.</p>
```

- [ ] **Step 7: Commit**

```bash
git add expense-intake/README.md platform.html investors.html privacy.html
git commit -m "Document email receipt intake in README, onboarding config, marketing copy, and privacy policy"
```

---

### Task 11: Manual ops steps (not automated — perform once, per environment)

These are infrastructure actions with real-world side effects (DNS, live routing rules, a remote D1 migration). Nothing in this task is code; do it yourself when ready to actually turn the channel on, the same way the existing Twilio number purchase and Google Sheet creation/sharing steps in the README are manual.

- [ ] Run the migration against the remote D1 database:
  ```bash
  cd expense-intake
  npx wrangler d1 execute expense-intake-db --file=migrations/0004_add_email_identity.sql          # remote
  npx wrangler d1 execute expense-intake-db --local --file=migrations/0004_add_email_identity.sql  # local dev
  ```
- [ ] Enable Email Routing and Email Sending for the subdomain (see the README section added in Task 10, Step 3).
- [ ] Create the routing rule sending `receipts@intake.venturesdatasolutions.com` to this Worker.
- [ ] Deploy: `npx wrangler deploy` (from `expense-intake/`).
- [ ] Smoke-test with a real email from an address already in `authorized_senders` (or add yourself as an email-only sender via `onboard-client.js` first) — confirm the reply arrives and the expense lands on the right Sheet. Pay particular attention to the `storeReceiptPhotoFromBytes` note in `src/receipt-storage.js` (Task 6) about whether the Images binding's `.input()` needs a `ReadableStream` instead of a `Uint8Array` — there's no local emulation for that binding, so this is the first real confirmation either way.
- [ ] Update any authorized senders who've said they'd rather not receive texts: add their `email` to `authorized_senders` (via a new `onboard-client.js` run, or a direct `UPDATE authorized_senders SET email = ? WHERE id = ?` for an existing row) so they can stop relying on SMS entirely.

---

## Plan self-review notes

- **Spec coverage:** §1 (infra) → Task 9/11. §2 (data model) → Task 1/2/3. §3 (pipeline reuse) → Task 7. §4 (email-specific handling) → Task 5/6/8. §5 (testing) → Tasks 1–9 each carry their own tests; the four required end-to-end scenarios are in Task 8. §6 (docs) → Task 10.
- **Known open item carried into Task 11, not this plan's code:** whether the real Cloudflare Images binding's `.input()` accepts a `Uint8Array` directly or needs a `ReadableStream` — flagged inline in Task 6 and Task 11, matching the project's existing practice of calling out real-binding uncertainties the local test suite can't cover (see the README's pre-existing Images binding caveat).
