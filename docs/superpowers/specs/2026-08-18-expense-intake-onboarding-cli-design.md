# Expense Intake Worker — Onboarding CLI Script — Design Spec

Date: 2026-08-18
Scope: Build Order step 9 (the final step) of `docs/superpowers/plans/2026-08-17-expense-intake-worker.md` — a locally-run script that onboards a new client end-to-end: creates the `clients`/`houses`/`authorized_senders` D1 rows, and auto-creates + shares each house's Google Sheet, replacing the manual SQL and manual Sheet setup every prior step's README has pointed at as a stopgap.

## Scope boundary

**Not automated:** provisioning the Twilio phone number itself (a real purchase with billing implications — stays a deliberate, manual step via the Twilio console/CLI) and pointing that number's messaging webhook at the deployed Worker (already documented in the README; still a one-time manual step after this script runs). The config file takes an **already-provisioned** `twilioNumber` as input.

## Invocation

```bash
node expense-intake/scripts/onboard-client.js <config.json> <service-account.json> [--local]
```

- `config.json` — the new client's data (shape below).
- `service-account.json` — the same Google service-account key file already used for `GOOGLE_SERVICE_ACCOUNT_JSON`, passed as a local file path here since this script runs outside the Worker and has no `env` binding to read a secret from.
- `--local` — targets the local D1 emulation (`wrangler d1 execute --local`) instead of the real remote database, for dry-run testing before onboarding a real client.

**Config file shape:**
```json
{
  "businessName": "Acme Rentals",
  "email": "owner@acme-rentals.com",
  "accountingSoftware": "quickbooks_online",
  "twilioNumber": "+15559876543",
  "carePlanTier": "standard",
  "houses": [
    { "address": "123 Main St", "nickname": "Main St" },
    { "address": "456 Oak Ave", "nickname": null }
  ],
  "authorizedSenders": [
    { "phoneNumber": "+15551234567", "label": "Owner" },
    { "phoneNumber": "+15559998888", "label": "Property Manager" }
  ]
}
```
`email` is used only to share each Sheet as Viewer — it is never written to D1 (`clients` has no email column, and none is added; this is a one-time onboarding input, not something the Worker needs at runtime). `carePlanTier` is optional (nullable in the schema already).

## Google Sheet auto-creation

For each house, the script:
1. Creates a new spreadsheet (`POST https://sheets.googleapis.com/v4/spreadsheets`) titled `"{businessName} — {nickname or address}"`.
2. Writes the header row (`Date`, `Vendor`, `Amount`, `Category`, `Confidence`, `Photo`, `Raw Text`, `Logged By`, `Notes` — matching `fileExpense`'s existing append column order exactly) via `values.update` on `Sheet1!A1:I1`.
3. Shares the spreadsheet with `config.email` as a Viewer (`POST https://www.googleapis.com/drive/v3/files/{id}/permissions`, `{ role: 'reader', type: 'user', emailAddress }`) — Google sends the client an email notification automatically.

**New Google auth scope:** step 3 needs Drive API access, which the existing `SHEETS_SCOPE` (`.../auth/spreadsheets`) doesn't grant. `getGoogleAccessToken` gains an optional `scope` parameter (defaulting to the existing `SHEETS_SCOPE`, so every existing Worker-runtime call site is unaffected), and a new exported `DRIVE_FILE_SCOPE` constant (`.../auth/drive.file` — the least-privilege Drive scope, granting access only to files the service account itself creates, not blanket Drive access). The onboarding script requests both scopes space-joined in one token request (`${SHEETS_SCOPE} ${DRIVE_FILE_SCOPE}`).

The three new Sheets/Drive REST functions (`createSpreadsheet`, `writeHeaderRow`, `shareSpreadsheetWithEmail`) are added to the existing `sheets.js` — all Sheets/Drive API surface area already lives there (`appendExpenseRow`, `extractAppendedRowNumber`, `deleteSheetRow`).

## D1 writes

The script builds a single multi-statement SQL string and executes it in one `wrangler d1 execute --file=<tmp>.sql` subprocess call (a temp file, not `--command`, to avoid shell-escaping/length concerns with multiple houses and senders in one run). Since D1's CLI doesn't return an insert's `last_row_id` in a way this script can capture per-statement, subsequent `INSERT`s reference the just-created client via a subquery on `twilio_number` (`UNIQUE` in the schema, and known upfront from the config):

```sql
INSERT INTO clients (business_name, care_plan_tier, twilio_number, accounting_software, status)
VALUES ('Acme Rentals', 'standard', '+15559876543', 'quickbooks_online', 'active');

INSERT INTO houses (client_id, address, nickname, google_sheet_id)
VALUES ((SELECT id FROM clients WHERE twilio_number = '+15559876543'), '123 Main St', 'Main St', '<sheet-id>');

INSERT INTO authorized_senders (client_id, phone_number, label)
VALUES ((SELECT id FROM clients WHERE twilio_number = '+15559876543'), '+15551234567', 'Owner');
```

String values are single-quote-escaped (doubling embedded `'`) when interpolated into this SQL — the config file is operator-authored, not untrusted user input, but the same escaping discipline applies regardless.

## Architecture: pure logic vs. CLI entrypoint

Following this project's established pattern (small testable modules, thin entrypoint):
- `src/onboarding.js` exports `buildOnboardingSql(config, housesWithSheetIds)` (a pure function — string in, string out, fully unit-testable) and `createHouseSheets(config, env, deps)` (the Sheets/Drive orchestration loop, testable via `deps.fetchImpl` injection exactly like every other module in this codebase).
- `scripts/onboard-client.js` is the actual CLI entrypoint: reads and validates the two file arguments, calls `createHouseSheets` then `buildOnboardingSql`, writes the result to a temp file, and shells out to `wrangler d1 execute` via an injectable `deps.runWrangler` (defaulting to a real `child_process.execFileSync` call — injectable so `onboardClient`, the function tying all three steps together, can be unit-tested against a fake that just records the call instead of really invoking wrangler). Prints a summary (client name, each house's new Sheet URL, a reminder to point the Twilio webhook) when done.

## Validation

Before doing anything with side effects, the script validates: `accountingSoftware` is one of the five schema-enforced values, `houses` and `authorizedSenders` are both non-empty arrays, and `email`/`twilioNumber`/`businessName` are non-empty strings. A validation failure exits before any Google API call or D1 write is attempted — no partial onboarding from a config typo.

## Out of scope

- Automatic Twilio phone number provisioning (explicit scope boundary above).
- Any rollback/undo if the script fails partway (e.g., Sheets created but the D1 write then fails) — this is a rare, operator-run, low-volume administrative script; a failure is surfaced loudly (thrown error, non-zero exit) for the operator to manually clean up and re-run, not auto-recovered.
- A "list/update existing client" mode — this script only handles first-time onboarding of a brand-new client.
