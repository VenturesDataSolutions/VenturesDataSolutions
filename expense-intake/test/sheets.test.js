// expense-intake/test/sheets.test.js
import { appendExpenseRow, extractAppendedRowNumber, deleteSheetRow, createSpreadsheet, writeHeaderRow, shareSpreadsheetWithEmail } from '../src/sheets.js';

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

  // extractAppendedRowNumber: parses the row number out of a real append response shape
  const rowNumber = extractAppendedRowNumber({ spreadsheetId: 'sheet123', updates: { updatedRange: 'Sheet1!A5:I5', updatedRows: 1 } });
  assert(rowNumber === 5, 'extractAppendedRowNumber must parse the row number out of updatedRange');

  // extractAppendedRowNumber: a multi-row append parses the starting row
  const multiRowNumber = extractAppendedRowNumber({ updates: { updatedRange: 'Sheet1!A12:I14' } });
  assert(multiRowNumber === 12, 'extractAppendedRowNumber must parse the starting row number for a multi-row range');

  // extractAppendedRowNumber: missing updates.updatedRange throws
  let threwMissingRange = false;
  try {
    extractAppendedRowNumber({ spreadsheetId: 'sheet123' });
  } catch { threwMissingRange = true; }
  assert(threwMissingRange, 'extractAppendedRowNumber must throw when updates.updatedRange is missing');

  // deleteSheetRow
  const deleteFetch = fakeFetch(true, 200, { spreadsheetId: 'sheet123', replies: [{}] });
  await deleteSheetRow({ accessToken: 'ya29.token', spreadsheetId: 'sheet123', sheetRow: 5, fetchImpl: deleteFetch });
  const deleteCall = deleteFetch.calls[0];
  assert(deleteCall.url === 'https://sheets.googleapis.com/v4/spreadsheets/sheet123:batchUpdate', 'deleteSheetRow must hit the batchUpdate endpoint for the given spreadsheetId');
  assert(deleteCall.init.headers.Authorization === 'Bearer ya29.token', 'deleteSheetRow must send the access token as a Bearer token');
  const deleteBody = JSON.parse(deleteCall.init.body);
  const deleteDimension = deleteBody.requests[0].deleteDimension;
  assert(deleteDimension.range.sheetId === 0, 'deleteSheetRow must target the standard Sheet1 tab (gid 0)');
  assert(deleteDimension.range.dimension === 'ROWS', 'deleteSheetRow must delete a row dimension, not columns');
  assert(deleteDimension.range.startIndex === 4 && deleteDimension.range.endIndex === 5, 'deleteSheetRow must convert the 1-indexed sheetRow (5) to the 0-indexed, exclusive-end startIndex/endIndex (4, 5) the batchUpdate API expects');

  // deleteSheetRow: error path
  const deleteFailFetch = fakeFetch(false, 403, { error: { message: 'The caller does not have permission' } });
  let threwDeleteError = false;
  try {
    await deleteSheetRow({ accessToken: 'bad', spreadsheetId: 'sheet123', sheetRow: 5, fetchImpl: deleteFailFetch });
  } catch (err) {
    threwDeleteError = true;
    assert(err.message === 'The caller does not have permission', 'deleteSheetRow must surface the Sheets API error message');
  }
  assert(threwDeleteError, 'a non-2xx batchUpdate response must throw');

  // createSpreadsheet
  const createFetch = fakeFetch(true, 200, { spreadsheetId: 'new_sheet_123' });
  const spreadsheetId = await createSpreadsheet({ accessToken: 'ya29.token', title: 'Acme Rentals — Main St', fetchImpl: createFetch });
  assert(spreadsheetId === 'new_sheet_123', 'createSpreadsheet must return the new spreadsheetId');
  const createCall = createFetch.calls[0];
  assert(createCall.url === 'https://sheets.googleapis.com/v4/spreadsheets', 'createSpreadsheet must POST to the Sheets API base to create a new spreadsheet');
  const createBody = JSON.parse(createCall.init.body);
  assert(createBody.properties.title === 'Acme Rentals — Main St', 'createSpreadsheet must set the spreadsheet title');
  assert(createBody.sheets[0].properties.title === 'Sheet1', 'createSpreadsheet must name the first tab Sheet1, matching the fixed range every append/delete call already assumes');

  // createSpreadsheet: error path
  const createFailFetch = fakeFetch(false, 403, { error: { message: 'insufficient permission' } });
  let threwCreate = false;
  try {
    await createSpreadsheet({ accessToken: 'bad', title: 'x', fetchImpl: createFailFetch });
  } catch (err) {
    threwCreate = true;
    assert(err.message === 'insufficient permission', 'createSpreadsheet must surface the Sheets API error message');
  }
  assert(threwCreate, 'a non-2xx create response must throw');

  // writeHeaderRow
  const headerFetch = fakeFetch(true, 200, { updatedRange: 'Sheet1!A1:I1' });
  await writeHeaderRow({ accessToken: 'ya29.token', spreadsheetId: 'new_sheet_123', fetchImpl: headerFetch });
  const headerCall = headerFetch.calls[0];
  assert(headerCall.url.includes('/new_sheet_123/values/') && headerCall.url.includes(encodeURIComponent('Sheet1!A1:I1')), 'writeHeaderRow must PUT to the Sheet1!A1:I1 range for the given spreadsheetId');
  assert(headerCall.init.method === 'PUT', 'writeHeaderRow must use PUT (values.update), not append');
  const headerBody = JSON.parse(headerCall.init.body);
  assert(
    JSON.stringify(headerBody.values[0]) === JSON.stringify(['Date', 'Vendor', 'Amount', 'Category', 'Confidence', 'Photo', 'Raw Text', 'Logged By', 'Notes']),
    "writeHeaderRow must write the exact 9 column headers, matching fileExpense's append column order"
  );

  // shareSpreadsheetWithEmail
  const shareFetch = fakeFetch(true, 200, { id: 'permission123' });
  await shareSpreadsheetWithEmail({ accessToken: 'ya29.token', spreadsheetId: 'new_sheet_123', email: 'owner@acme-rentals.com', fetchImpl: shareFetch });
  const shareCall = shareFetch.calls[0];
  assert(shareCall.url === 'https://www.googleapis.com/drive/v3/files/new_sheet_123/permissions', 'shareSpreadsheetWithEmail must POST to the Drive API permissions endpoint for the given spreadsheetId');
  const shareBody = JSON.parse(shareCall.init.body);
  assert(shareBody.role === 'reader' && shareBody.type === 'user' && shareBody.emailAddress === 'owner@acme-rentals.com', 'shareSpreadsheetWithEmail must share as a reader (Viewer) with the given email');

  // shareSpreadsheetWithEmail: error path
  const shareFailFetch = fakeFetch(false, 400, { error: { message: 'Invalid sharing request' } });
  let threwShare = false;
  try {
    await shareSpreadsheetWithEmail({ accessToken: 'bad', spreadsheetId: 'new_sheet_123', email: 'bad-email', fetchImpl: shareFailFetch });
  } catch (err) {
    threwShare = true;
    assert(err.message === 'Invalid sharing request', 'shareSpreadsheetWithEmail must surface the Drive API error message');
  }
  assert(threwShare, 'a non-2xx share response must throw');

  console.log('PASS: sheets.test.js');
}

await main();
