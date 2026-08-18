// expense-intake/test/sheets.test.js
import { appendExpenseRow } from '../src/sheets.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function fakeFetch(ok, status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  const okBody = { spreadsheetId: 'sheet123', updates: { updatedRows: 1 } };
  const fetchImpl = fakeFetch(true, 200, okBody);
  const row = ['2026-08-17', 'Home Depot', 42.5, 'Materials', 0.9, 'https://x/receipts/key.jpg', 'HD $42.50', '+15551234567', ''];

  const result = await appendExpenseRow({ accessToken: 'ya29.token', spreadsheetId: 'sheet123', row, fetchImpl });
  assert(result === okBody, 'appendExpenseRow must return the parsed response body');

  const call = fetchImpl.calls[0];
  assert(call.url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/sheet123/values/'), 'must hit the values:append endpoint for the given spreadsheetId');
  assert(call.url.includes(':append'), 'must use the :append action');
  assert(call.url.includes(encodeURIComponent('Sheet1!A:I')), 'must target the Sheet1!A:I range');
  assert(call.url.includes('valueInputOption=USER_ENTERED'), "must use USER_ENTERED so numbers/dates are interpreted, not stored as literal text (required for the Tax Rollup tab's SUM to work)");
  assert(call.url.includes('insertDataOption=INSERT_ROWS'), 'must use INSERT_ROWS so appending never overwrites existing data');
  assert(call.init.headers.Authorization === 'Bearer ya29.token', 'must send the access token as a Bearer token');
  const body = JSON.parse(call.init.body);
  assert(Array.isArray(body.values) && body.values.length === 1 && JSON.stringify(body.values[0]) === JSON.stringify(row), 'must wrap the row in a single-row values array');

  // error path
  const failFetch = fakeFetch(false, 403, { error: { message: 'The caller does not have permission' } });
  let threw = false;
  try {
    await appendExpenseRow({ accessToken: 'bad', spreadsheetId: 'sheet123', row, fetchImpl: failFetch });
  } catch (err) {
    threw = true;
    assert(err.message === 'The caller does not have permission', 'must surface the Sheets API error message');
  }
  assert(threw, 'a non-2xx Sheets API response must throw');

  console.log('PASS: sheets.test.js');
}

await main();
