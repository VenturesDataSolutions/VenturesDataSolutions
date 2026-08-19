// expense-intake/src/sheets.js
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const APPEND_RANGE = 'Sheet1!A:I'; // fixed tab/column layout — onboarding (not yet built) is expected to create every house's Sheet with this same structure, per Step 4's design note
const DEFAULT_SHEET_ID = 0; // gid of the standard "Sheet1" tab every house's spreadsheet is assumed to use — see Step 5's design spec
const HEADER_ROW = ['Date', 'Vendor', 'Amount', 'Category', 'Confidence', 'Photo', 'Raw Text', 'Logged By', 'Notes'];

export async function appendExpenseRow({ accessToken, spreadsheetId, row, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const range = encodeURIComponent(APPEND_RANGE);
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: [row] }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.error && data.error.message) || `Sheets API request failed with status ${response.status}`;
    throw new Error(message);
  }
  return data;
}

// Parses the 1-indexed row number a row landed on out of an appendExpenseRow response's
// updates.updatedRange (e.g. "Sheet1!A5:I5" -> 5), so it can be targeted for deletion later
// if the client corrects which house an expense belongs to (Step 5).
export function extractAppendedRowNumber(appendResponse) {
  const range = appendResponse && appendResponse.updates && appendResponse.updates.updatedRange;
  if (!range) {
    throw new Error('Sheets append response missing updates.updatedRange');
  }
  const match = range.match(/![A-Z]+(\d+)/);
  if (!match) {
    throw new Error(`Could not parse a row number out of updatedRange: ${range}`);
  }
  return Number(match[1]);
}

export async function deleteSheetRow({ accessToken, spreadsheetId, sheetRow, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: { sheetId: DEFAULT_SHEET_ID, dimension: 'ROWS', startIndex: sheetRow - 1, endIndex: sheetRow },
        },
      }],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.error && data.error.message) || `Sheets API request failed with status ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export async function writeHeaderRow({ accessToken, spreadsheetId, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const range = encodeURIComponent('Sheet1!A1:I1');
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${range}?valueInputOption=RAW`;
  const response = await doFetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: [HEADER_ROW] }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.error && data.error.message) || `Sheets API request failed with status ${response.status}`;
    throw new Error(message);
  }
  return data;
}
