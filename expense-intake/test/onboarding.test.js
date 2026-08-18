// expense-intake/test/onboarding.test.js
import crypto from 'node:crypto';
import { validateConfig, buildOnboardingSql, createHouseSheets, onboardClient } from '../src/onboarding.js';

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
    ['sheets.googleapis.com/v4/spreadsheets', async (url, init) => {
      if (init.method === 'POST' && !url.includes('/values/')) {
        return { ok: true, status: 200, json: async () => ({ spreadsheetId: 'new_sheet_1' }) };
      }
      return { ok: true, status: 200, json: async () => ({ updatedRange: 'Sheet1!A1:I1' }) };
    }],
    ['drive/v3/files', async () => ({ ok: true, status: 200, json: async () => ({ id: 'perm1' }) })],
  ];
}

async function main() {
  // validateConfig: a fully valid config must not throw
  {
    const validConfig = {
      businessName: 'Acme Rentals', email: 'owner@acme-rentals.com', twilioNumber: '+15559876543',
      accountingSoftware: 'quickbooks_online',
      houses: [{ address: '123 Main St', nickname: null }],
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
    assert(sql.includes("'sheet_abc'") && sql.includes("'sheet_def'"), "must interpolate each house's created googleSheetId");
    assert((sql.match(/INSERT INTO authorized_senders/g) || []).length === 2, 'must include one authorized_senders INSERT per sender');
    assert(sql.includes('NULL'), 'a null nickname/label must be written as SQL NULL, not the string "null"');
  }

  // createHouseSheets
  {
    const config = {
      businessName: 'Acme Rentals',
      email: 'owner@acme-rentals.com',
      houses: [{ address: '123 Main St', nickname: 'Main St' }],
    };
    const fetchImpl = fakeFetch(googleApiFetchHandlers());
    const result = await createHouseSheets(config, { serviceAccountJson: generateTestServiceAccount(), fetchImpl });
    assert(result.length === 1 && result[0].googleSheetId === 'new_sheet_1', 'createHouseSheets must attach the newly created spreadsheetId to each house');
    const shareCall = fetchImpl.calls.find((c) => c.url.includes('/permissions'));
    assert(shareCall, 'createHouseSheets must share the new spreadsheet');
    const shareBody = JSON.parse(shareCall.init.body);
    assert(shareBody.emailAddress === 'owner@acme-rentals.com', 'createHouseSheets must share with the configured email');
  }

  // onboardClient ties createHouseSheets + buildOnboardingSql + runWrangler together
  {
    const config = {
      businessName: 'Acme Rentals',
      email: 'owner@acme-rentals.com',
      carePlanTier: null,
      twilioNumber: '+15559876543',
      accountingSoftware: 'quickbooks_online',
      houses: [{ address: '123 Main St', nickname: 'Main St' }],
      authorizedSenders: [{ phoneNumber: '+15551234567', label: 'Owner' }],
    };
    const fetchImpl = fakeFetch(googleApiFetchHandlers());
    let ranSql = null;
    const runWrangler = async (sql) => { ranSql = sql; };
    const result = await onboardClient(config, { serviceAccountJson: generateTestServiceAccount(), fetchImpl, runWrangler });
    assert(result.housesWithSheets[0].googleSheetId === 'new_sheet_1', 'onboardClient must return the houses with their created googleSheetId');
    assert(ranSql && ranSql.includes('new_sheet_1'), 'onboardClient must pass SQL referencing the newly created sheet id to runWrangler');
    assert(ranSql.includes('INSERT INTO clients') && ranSql.includes('INSERT INTO authorized_senders'), 'onboardClient must run the full onboarding SQL, not just the houses portion');
  }

  console.log('PASS: onboarding.test.js');
}

await main();
