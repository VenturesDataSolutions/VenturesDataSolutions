// expense-intake/src/vcard.js
export function buildVCard({ businessName, phoneNumber }) {
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${businessName} Expense Tracker`,
    `TEL;TYPE=CELL:${phoneNumber}`,
    'END:VCARD',
  ].join('\r\n') + '\r\n';
}
