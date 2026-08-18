import {
  findClientByTwilioNumber,
  findAuthorizedSender,
  findHousesForClient,
  insertExpense,
  insertPendingReview,
  findPendingReviewById,
  deletePendingReview,
  findExpenseById,
  updateExpenseHouse,
  findOldestPendingReviewForClient,
  findNextPendingReviewForClient,
  deleteExpiredPendingReviews,
  findActiveClientsWithPendingCounts,
  findAuthorizedSendersForClient,
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

  // insertExpense: now binds 11 params (adds sheet_row) and returns the new row's id
  const db6 = createFakeD1();
  const newExpenseId = await insertExpense(db6, {
    houseId: 10, date: '2026-08-17', vendor: 'Home Depot', amount: 42.5, category: 'Materials',
    confidence: 0.9, photoR2Key: 'receipts/x/1.jpg', rawText: 'HD $42.50', loggedByPhone: '+15551234567', notes: '', sheetRow: 5,
  });
  const insertCall = db6.calls[0];
  assert(insertCall.sql.includes('INSERT INTO expenses'), 'insertExpense must INSERT into the expenses table');
  assert(insertCall.params[0] === 10 && insertCall.params[1] === '2026-08-17' && insertCall.params[4] === 'Materials', 'must bind house_id, date, and category in the expected column order');
  assert(
    JSON.stringify(insertCall.params) === JSON.stringify([
      10, '2026-08-17', 'Home Depot', 42.5, 'Materials', 0.9, 'receipts/x/1.jpg', 'HD $42.50', '+15551234567', '', 5,
    ]),
    'insertExpense must bind all 11 params (house_id, date, vendor, amount, category, confidence, photo_r2_key, raw_text, logged_by_phone, notes, sheet_row) in exact column order'
  );
  assert(newExpenseId === 1, "insertExpense must return the new row's id from result.meta.last_row_id");

  // insertExpense: notes defaults to empty string and sheet_row defaults to null when omitted
  const db7 = createFakeD1();
  await insertExpense(db7, {
    houseId: 10, date: '2026-08-17', vendor: null, amount: null, category: 'Other',
    confidence: 0.2, photoR2Key: null, rawText: '', loggedByPhone: '+15551234567',
  });
  assert(db7.calls[0].params[9] === '', 'insertExpense must default a missing notes value to an empty string, not undefined');
  assert(
    JSON.stringify(db7.calls[0].params) === JSON.stringify([
      10, '2026-08-17', null, null, 'Other', 0.2, null, '', '+15551234567', '', null,
    ]),
    'insertExpense must bind all 11 params correctly even when vendor/amount/photoR2Key/sheet_row are null and notes is omitted'
  );

  // insertPendingReview: now returns the new row's id
  const db8 = createFakeD1();
  const newPendingId = await insertPendingReview(db8, {
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
  assert(newPendingId === 1, "insertPendingReview must return the new row's id from result.meta.last_row_id");

  // findPendingReviewById
  const pendingRow = { id: 99, client_id: 1, house_id: null, amount_guess: 10, category_guess: 'Materials', photo_r2_key: null, raw_text: 'Lowes $10', confidence: 0.95 };
  const db9 = createFakeD1({ 'SELECT * FROM pending_review WHERE id = ?': pendingRow });
  const foundPending = await findPendingReviewById(db9, 99);
  assert(foundPending === pendingRow, 'findPendingReviewById must return the row from the fake DB');
  assert(db9.calls[0].params[0] === 99, 'must bind the pending_review id as the query parameter');

  // deletePendingReview
  const db10 = createFakeD1();
  await deletePendingReview(db10, 99);
  assert(db10.calls[0].sql.includes('DELETE FROM pending_review'), 'deletePendingReview must DELETE from the pending_review table');
  assert(db10.calls[0].params[0] === 99, 'must bind the pending_review id to delete');

  // findExpenseById
  const expenseRow = { id: 42, house_id: 10, date: '2026-08-17', vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.9, photo_r2_key: 'receipts/x/1.jpg', raw_text: 'HD $42.50', logged_by_phone: '+15551234567', notes: '', sheet_row: 5 };
  const db11 = createFakeD1({ 'SELECT * FROM expenses WHERE id = ?': expenseRow });
  const foundExpense = await findExpenseById(db11, 42);
  assert(foundExpense === expenseRow, 'findExpenseById must return the row from the fake DB');
  assert(db11.calls[0].params[0] === 42, 'must bind the expense id as the query parameter');

  // updateExpenseHouse
  const db12 = createFakeD1();
  await updateExpenseHouse(db12, { expenseId: 42, houseId: 11, sheetRow: 8 });
  assert(db12.calls[0].sql.includes('UPDATE expenses SET house_id'), "updateExpenseHouse must UPDATE the expenses table's house_id (and sheet_row)");
  assert(
    JSON.stringify(db12.calls[0].params) === JSON.stringify([11, 8, 42]),
    'updateExpenseHouse must bind house_id, sheet_row, then the expense id (matching the SET ... WHERE id = ? clause order)'
  );

  // findOldestPendingReviewForClient
  const oldestPending = { id: 50, client_id: 1, house_id: null, amount_guess: 10, category_guess: 'Materials', photo_r2_key: null, raw_text: 'Lowes $10', confidence: 0.6 };
  const db13 = createFakeD1({ 'SELECT * FROM pending_review WHERE client_id = ? ORDER BY id ASC LIMIT 1': oldestPending });
  const foundOldest = await findOldestPendingReviewForClient(db13, 1);
  assert(foundOldest === oldestPending, 'findOldestPendingReviewForClient must return the row from the fake DB');
  assert(db13.calls[0].params[0] === 1, 'must bind clientId as the query parameter');

  // findOldestPendingReviewForClient: none found
  const db14 = createFakeD1({ 'SELECT * FROM pending_review WHERE client_id = ? ORDER BY id ASC LIMIT 1': null });
  const noOldest = await findOldestPendingReviewForClient(db14, 999);
  assert(noOldest === null, 'findOldestPendingReviewForClient must return null when the client has no pending items');

  // findNextPendingReviewForClient
  const nextPending = { id: 51, client_id: 1, house_id: 10, amount_guess: 42, category_guess: 'Materials', photo_r2_key: null, raw_text: 'HD $42', confidence: 0.5 };
  const db15 = createFakeD1({ 'SELECT * FROM pending_review WHERE client_id = ? AND id > ? ORDER BY id ASC LIMIT 1': nextPending });
  const foundNext = await findNextPendingReviewForClient(db15, 1, 50);
  assert(foundNext === nextPending, 'findNextPendingReviewForClient must return the row from the fake DB');
  assert(db15.calls[0].params[0] === 1 && db15.calls[0].params[1] === 50, 'must bind clientId then afterId, in that order');

  // findNextPendingReviewForClient: none found (was the last item)
  const db16 = createFakeD1({ 'SELECT * FROM pending_review WHERE client_id = ? AND id > ? ORDER BY id ASC LIMIT 1': null });
  const noNext = await findNextPendingReviewForClient(db16, 1, 999);
  assert(noNext === null, 'findNextPendingReviewForClient must return null when there is no item after the cursor');

  // deleteExpiredPendingReviews
  const db17 = createFakeD1({ 'DELETE FROM pending_review WHERE expires_at < ?': { success: true, meta: { changes: 3 } } });
  const deletedCount = await deleteExpiredPendingReviews(db17, '2026-08-18T00:00:00.000Z');
  assert(deletedCount === 3, 'deleteExpiredPendingReviews must return the number of rows deleted');
  assert(db17.calls[0].params[0] === '2026-08-18T00:00:00.000Z', 'must bind the current time as the expiry cutoff');

  // findActiveClientsWithPendingCounts
  const pendingCounts = [{ client_id: 1, twilio_number: '+15559876543', pending_count: 2 }];
  const db18 = createFakeD1({ "SELECT c.id AS client_id, c.twilio_number AS twilio_number, COUNT(pr.id) AS pending_count FROM clients c JOIN pending_review pr ON pr.client_id = c.id WHERE c.status = 'active' GROUP BY c.id": pendingCounts });
  const counts = await findActiveClientsWithPendingCounts(db18);
  assert(counts === pendingCounts, 'findActiveClientsWithPendingCounts must return the results array from the fake DB');

  // findAuthorizedSendersForClient
  const senders = [{ id: 5, client_id: 1, phone_number: '+15551234567' }, { id: 6, client_id: 1, phone_number: '+15559998888' }];
  const db19 = createFakeD1({ 'SELECT * FROM authorized_senders WHERE client_id = ?': senders });
  const foundSenders = await findAuthorizedSendersForClient(db19, 1);
  assert(foundSenders === senders, 'findAuthorizedSendersForClient must return the results array from the fake DB');
  assert(db19.calls[0].params[0] === 1, 'must bind clientId as the query parameter');

  console.log('PASS: db.test.js');
}

await main();
