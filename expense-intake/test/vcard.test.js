// expense-intake/test/vcard.test.js
import { buildVCard } from '../src/vcard.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  const vcard = buildVCard({ businessName: 'Acme Rentals', phoneNumber: '+15559876543' });
  assert(vcard.startsWith('BEGIN:VCARD\r\n'), 'vCard must start with the BEGIN:VCARD line, CRLF-terminated per spec');
  assert(vcard.includes('VERSION:3.0\r\n'), 'vCard must declare VERSION:3.0');
  assert(vcard.includes('FN:Acme Rentals Expense Tracker\r\n'), 'vCard must set the formatted name to the business name plus "Expense Tracker"');
  assert(vcard.includes('TEL;TYPE=CELL:+15559876543\r\n'), "vCard must include the client's Twilio number as a cell TEL field");
  assert(vcard.trim().endsWith('END:VCARD'), 'vCard must end with the END:VCARD line');

  console.log('PASS: vcard.test.js');
}

await main();
