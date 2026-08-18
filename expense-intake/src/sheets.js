// expense-intake/src/sheets.js
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const APPEND_RANGE = 'Sheet1!A:I'; // fixed tab/column layout — onboarding (not yet built) is expected to create every house's Sheet with this same structure, per Step 4's design note

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
