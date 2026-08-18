import {
  findClientByTwilioNumber,
  findAuthorizedSender,
  findHousesForClient,
  insertExpense,
  insertPendingReview,
} from '../src/db.js';
import { createFakeD1 } from './fake-d1.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  // findClientByTwilioNumber
  const clientRow = { id: 1, business_name: 'Acme Rentals', twilio_number: '+15559876543' };
  const db1 = createFakeD1({
    'SELECT * FROM clients WHERE twilio_number = ?': clientRow,
  });
  const client = await findClientByTwilioNumber(db1, '+15559876543');
  assert(client === clientRow, 'findClientByTwilioNumber must return the row from the fake DB');
  assert(db1.calls[0].params[0] === '+15559876543', 'must bind the Twilio number as the query parameter');

  // findClientByTwilioNumber: not found
  const db2 = createFakeD1({ 'SELECT * FROM clients WHERE twilio_number = ?': null });
  const missingClient = await findClientByTwilioNumber(db2, '+10000000000');
  assert(missingClient === null, 'findClientByTwilioNumber must return null when no client matches');

  // findAuthorizedSender
  const senderRow = { id: 5, client_id: 1, phone_number: '+15551234567' };
  const db3 = createFakeD1({
    'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': senderRow,
  });
  const sender = await findAuthorizedSender(db3, 1, '+15551234567');
  assert(sender === senderRow, 'findAuthorizedSender must return the row from the fake DB');
  assert(db3.calls[0].params[0] === 1 && db3.calls[0].params[1] === '+15551234567', 'must bind clientId then phoneNumber, in that order');

  // findHousesForClient
  const houseRows = [{ id: 10, client_id: 1, address: '123 Main St' }, { id: 11, client_id: 1, address: '456 Oak Ave' }];
  const db4 = createFakeD1({
    'SELECT * FROM houses WHERE client_id = ?': houseRows,
  });
  const houses = await findHousesForClient(db4, 1);
  assert(houses === houseRows, 'findHousesForClient must return the results array from the fake DB');
  assert(db4.calls[0].params[0] === 1, 'must bind clientId as the query parameter');

  // findHousesForClient: none found
  const db5 = createFakeD1({ 'SELECT * FROM houses WHERE client_id = ?': [] });
  const noHouses = await findHousesForClient(db5, 999);
  assert(Array.isArray(noHouses) && noHouses.length === 0, 'findHousesForClient must return an empty array when the client has no houses');

  // insertExpense
  const db6 = createFakeD1();
  await insertExpense(db6, {
    houseId: 10, date: '2026-08-17', vendor: 'Home Depot', amount: 42.5, category: 'Materials',
    confidence: 0.9, photoR2Key: 'receipts/x/1.jpg', rawText: 'HD $42.50', loggedByPhone: '+15551234567', notes: '',
  });
  const insertCall = db6.calls[0];
  assert(insertCall.sql.includes('INSERT INTO expenses'), 'insertExpense must INSERT into the expenses table');
  assert(insertCall.params[0] === 10 && insertCall.params[1] === '2026-08-17' && insertCall.params[4] === 'Materials', 'must bind house_id, date, and category in the expected column order');
  assert(
    JSON.stringify(insertCall.params) === JSON.stringify([
      10, '2026-08-17', 'Home Depot', 42.5, 'Materials', 0.9, 'receipts/x/1.jpg', 'HD $42.50', '+15551234567', '',
    ]),
    'insertExpense must bind all 10 params (house_id, date, vendor, amount, category, confidence, photo_r2_key, raw_text, logged_by_phone, notes) in exact column order'
  );

  // insertExpense: notes defaults to empty string when omitted
  const db7 = createFakeD1();
  await insertExpense(db7, {
    houseId: 10, date: '2026-08-17', vendor: null, amount: null, category: 'Other',
    confidence: 0.2, photoR2Key: null, rawText: '', loggedByPhone: '+15551234567',
  });
  assert(db7.calls[0].params[9] === '', 'insertExpense must default a missing notes value to an empty string, not undefined');
  assert(
    JSON.stringify(db7.calls[0].params) === JSON.stringify([
      10, '2026-08-17', null, null, 'Other', 0.2, null, '', '+15551234567', '',
    ]),
    'insertExpense must bind all 10 params correctly even when vendor/amount/photoR2Key are null and notes is omitted'
  );

  // insertPendingReview
  const db8 = createFakeD1();
  await insertPendingReview(db8, {
    clientId: 1, houseId: null, amountGuess: null, categoryGuess: null,
    photoR2Key: 'receipts/x/2.jpg', rawText: 'unclear', confidence: 0, expiresAt: '2026-10-16T00:00:00.000Z',
  });
  const pendingCall = db8.calls[0];
  assert(pendingCall.sql.includes('INSERT INTO pending_review'), 'insertPendingReview must INSERT into the pending_review table');
  assert(pendingCall.params[0] === 1 && pendingCall.params[1] === null, 'must bind client_id and a null house_id when the house is ambiguous');
  assert(
    JSON.stringify(pendingCall.params) === JSON.stringify([
      1, null, null, null, 'receipts/x/2.jpg', 'unclear', 0, '2026-10-16T00:00:00.000Z',
    ]),
    'insertPendingReview must bind all 8 params (client_id, house_id, amount_guess, category_guess, photo_r2_key, raw_text, confidence, expires_at) in exact column order'
  );

  console.log('PASS: db.test.js');
}

await main();
