// expense-intake/test/onboarding.test.js
import crypto from 'node:crypto';
import { validateConfig, buildOnboardingSql, prepareHouseSheets, onboardClient } from '../src/onboarding.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function generateTestServiceAccount() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { client_email: 'onboard-sa@test.iam.gserviceaccount.com', private_key: privateKey };
}

function fakeFetch(handlers) {
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

function googleApiFetchHandlers() {
  return [
    ['oauth2.googleapis.com', async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'ya29.tok' }) })],
    ['sheets.googleapis.com/v4/spreadsheets', async () => ({ ok: true, status: 200, json: async () => ({ updatedRange: 'Sheet1!A1:I1' }) })],
  ];
}

async function main() {
  // validateConfig: a fully valid config must not throw
  {
    const validConfig = {
      businessName: 'Acme Rentals', twilioNumber: '+15559876543',
      accountingSoftware: 'quickbooks_online',
      houses: [{ address: '123 Main St', nickname: null, googleSheetId: 'sheet_abc' }],
      authorizedSenders: [{ phoneNumber: '+15551234567', label: null }],
    };
    let threwValid = false;
    try { validateConfig(validConfig); } catch { threwValid = true; }
    assert(!threwValid, 'a fully valid config must not throw');
  }

  // validateConfig: missing/invalid fields are all reported together, in one throw
  {
    let threwInvalid = false;
    try {
      validateConfig({ accountingSoftware: 'not_a_real_option', houses: [], authorizedSenders: [] });
    } catch (err) {
      threwInvalid = true;
      assert(err.message.includes('businessName'), 'must report a missing businessName');
      assert(err.message.includes('accountingSoftware'), 'must report an invalid accountingSoftware');
      assert(err.message.includes('houses'), 'must report an empty houses array');
      assert(err.message.includes('authorizedSenders'), 'must report an empty authorizedSenders array');
    }
    assert(threwInvalid, 'an invalid config must throw before any side effect is attempted');
  }

  // validateConfig: a house missing googleSheetId is reported (Sheets are created by hand,
  // not auto-created — a bare service account has no Drive storage quota of its own)
  {
    let threwMissingSheetId = false;
    try {
      validateConfig({
        businessName: 'Acme Rentals', twilioNumber: '+15559876543', accountingSoftware: 'quickbooks_online',
        houses: [{ address: '123 Main St', nickname: null }],
        authorizedSenders: [{ phoneNumber: '+15551234567', label: null }],
      });
    } catch (err) {
      threwMissingSheetId = true;
      assert(err.message.includes('houses[0].googleSheetId'), 'must report which house is missing a googleSheetId');
    }
    assert(threwMissingSheetId, 'a house with no googleSheetId must throw');
  }

  // buildOnboardingSql
  {
    const config = {
      businessName: "Acme's Rentals",
      carePlanTier: 'standard',
      twilioNumber: '+15559876543',
      accountingSoftware: 'quickbooks_online',
      authorizedSenders: [
        { phoneNumber: '+15551234567', label: 'Owner' },
        { phoneNumber: '+15559998888', label: null },
      ],
    };
    const housesWithSheets = [
      { address: '123 Main St', nickname: 'Main St', googleSheetId: 'sheet_abc' },
      { address: "456 O'Hare Ave", nickname: null, googleSheetId: 'sheet_def' },
    ];
    const sql = buildOnboardingSql(config, housesWithSheets);
    assert(sql.includes('INSERT INTO clients'), 'must include a clients INSERT');
    assert(sql.includes("Acme''s Rentals"), 'must escape single quotes in string values by doubling them');
    assert(sql.includes("'standard'") && sql.includes("'+15559876543'") && sql.includes("'quickbooks_online'"), 'must interpolate the client fields');
    assert((sql.match(/INSERT INTO houses/g) || []).length === 2, 'must include one houses INSERT per house');
    assert(sql.includes("(SELECT id FROM clients WHERE twilio_number = '+15559876543')"), 'houses/authorized_senders INSERTs must resolve client_id via a twilio_number subquery, not a captured last_row_id');
    assert(sql.includes("456 O''Hare Ave"), "must escape single quotes in a house's address too");
    assert(sql.includes("'sheet_abc'") && sql.includes("'sheet_def'"), "must interpolate each house's googleSheetId");
    assert((sql.match(/INSERT INTO authorized_senders/g) || []).length === 2, 'must include one authorized_senders INSERT per sender');
    assert(sql.includes('NULL'), 'a null nickname/label must be written as SQL NULL, not the string "null"');
  }

  // prepareHouseSheets: writes the header row into each house's already-created,
  // already-shared Sheet (no create/share calls — those aren't possible for a bare
  // service account, confirmed against the real API)
  {
    const config = {
      businessName: 'Acme Rentals',
      houses: [{ address: '123 Main St', nickname: 'Main St', googleSheetId: 'sheet_abc' }],
    };
    const fetchImpl = fakeFetch(googleApiFetchHandlers());
    const result = await prepareHouseSheets(config, { serviceAccountJson: generateTestServiceAccount(), fetchImpl });
    assert(result === config.houses, 'prepareHouseSheets must return the houses as-is (they already carry their googleSheetId)');
    const headerCall = fetchImpl.calls.find((c) => c.url.includes('/sheet_abc/values/'));
    assert(headerCall, 'prepareHouseSheets must write the header row into the given googleSheetId');
  }

  // onboardClient ties prepareHouseSheets + buildOnboardingSql + runWrangler together
  {
    const config = {
      businessName: 'Acme Rentals',
      carePlanTier: null,
      twilioNumber: '+15559876543',
      accountingSoftware: 'quickbooks_online',
      houses: [{ address: '123 Main St', nickname: 'Main St', googleSheetId: 'sheet_abc' }],
      authorizedSenders: [{ phoneNumber: '+15551234567', label: 'Owner' }],
    };
    const fetchImpl = fakeFetch(googleApiFetchHandlers());
    let ranSql = null;
    const runWrangler = async (sql) => { ranSql = sql; };
    const result = await onboardClient(config, { serviceAccountJson: generateTestServiceAccount(), fetchImpl, runWrangler });
    assert(result.housesWithSheets[0].googleSheetId === 'sheet_abc', 'onboardClient must return the houses (with their googleSheetId)');
    assert(ranSql && ranSql.includes('sheet_abc'), 'onboardClient must pass SQL referencing the house sheet id to runWrangler');
    assert(ranSql.includes('INSERT INTO clients') && ranSql.includes('INSERT INTO authorized_senders'), 'onboardClient must run the full onboarding SQL, not just the houses portion');
  }

  console.log('PASS: onboarding.test.js');
}

await main();
