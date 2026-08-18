// expense-intake/src/onboarding.js
import { getGoogleAccessToken, SHEETS_SCOPE, DRIVE_FILE_SCOPE } from './google-auth.js';
import { createSpreadsheet, writeHeaderRow, shareSpreadsheetWithEmail } from './sheets.js';

const ACCOUNTING_SOFTWARE_VALUES = ['quickbooks_online', 'quickbooks_desktop', 'wave', 'xero', 'csv'];

export function validateConfig(config) {
  const errors = [];
  if (!config.businessName) errors.push('businessName is required');
  if (!config.email) errors.push('email is required');
  if (!config.twilioNumber) errors.push('twilioNumber is required');
  if (!ACCOUNTING_SOFTWARE_VALUES.includes(config.accountingSoftware)) {
    errors.push(`accountingSoftware must be one of: ${ACCOUNTING_SOFTWARE_VALUES.join(', ')}`);
  }
  if (!Array.isArray(config.houses) || config.houses.length === 0) {
    errors.push('houses must be a non-empty array');
  }
  if (!Array.isArray(config.authorizedSenders) || config.authorizedSenders.length === 0) {
    errors.push('authorizedSenders must be a non-empty array');
  }
  if (errors.length > 0) {
    throw new Error(`Invalid onboarding config:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
}

function escapeSqlString(value) {
  return String(value).replace(/'/g, "''");
}

function sqlValue(value) {
  return value === null || value === undefined ? 'NULL' : `'${escapeSqlString(value)}'`;
}

export async function createHouseSheets(config, deps = {}) {
  const accessToken = await getGoogleAccessToken({
    serviceAccountJson: deps.serviceAccountJson,
    fetchImpl: deps.fetchImpl,
    scope: `${SHEETS_SCOPE} ${DRIVE_FILE_SCOPE}`,
  });

  const housesWithSheets = [];
  for (const house of config.houses) {
    const title = `${config.businessName} — ${house.nickname || house.address}`;
    const spreadsheetId = await createSpreadsheet({ accessToken, title, fetchImpl: deps.fetchImpl });
    await writeHeaderRow({ accessToken, spreadsheetId, fetchImpl: deps.fetchImpl });
    await shareSpreadsheetWithEmail({ accessToken, spreadsheetId, email: config.email, fetchImpl: deps.fetchImpl });
    housesWithSheets.push({ ...house, googleSheetId: spreadsheetId });
  }
  return housesWithSheets;
}

export function buildOnboardingSql(config, housesWithSheets) {
  const statements = [];

  statements.push(
    `INSERT INTO clients (business_name, care_plan_tier, twilio_number, accounting_software, status) VALUES (${sqlValue(config.businessName)}, ${sqlValue(config.carePlanTier ?? null)}, ${sqlValue(config.twilioNumber)}, ${sqlValue(config.accountingSoftware)}, 'active');`
  );

  // twilio_number is UNIQUE and known upfront, so subsequent INSERTs resolve client_id via
  // this subquery rather than depending on a captured last_row_id — wrangler d1 execute
  // --file doesn't hand one back per-statement in a way this script could otherwise use.
  const clientIdSubquery = `(SELECT id FROM clients WHERE twilio_number = ${sqlValue(config.twilioNumber)})`;

  for (const house of housesWithSheets) {
    statements.push(
      `INSERT INTO houses (client_id, address, nickname, google_sheet_id) VALUES (${clientIdSubquery}, ${sqlValue(house.address)}, ${sqlValue(house.nickname ?? null)}, ${sqlValue(house.googleSheetId)});`
    );
  }

  for (const sender of config.authorizedSenders) {
    statements.push(
      `INSERT INTO authorized_senders (client_id, phone_number, label) VALUES (${clientIdSubquery}, ${sqlValue(sender.phoneNumber)}, ${sqlValue(sender.label ?? null)});`
    );
  }

  return statements.join('\n');
}

export async function onboardClient(config, deps = {}) {
  const housesWithSheets = await createHouseSheets(config, deps);
  const sql = buildOnboardingSql(config, housesWithSheets);
  await deps.runWrangler(sql);
  return { housesWithSheets, sql };
}
