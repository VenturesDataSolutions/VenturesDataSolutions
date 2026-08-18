// expense-intake/src/db.js

export async function findClientByTwilioNumber(db, twilioNumber) {
  return db.prepare('SELECT * FROM clients WHERE twilio_number = ?').bind(twilioNumber).first();
}

export async function findAuthorizedSender(db, clientId, phoneNumber) {
  return db.prepare('SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?').bind(clientId, phoneNumber).first();
}

export async function findHousesForClient(db, clientId) {
  const result = await db.prepare('SELECT * FROM houses WHERE client_id = ?').bind(clientId).all();
  return result.results;
}

export async function insertExpense(db, { houseId, date, vendor, amount, category, confidence, photoR2Key, rawText, loggedByPhone, notes, sheetRow }) {
  const result = await db
    .prepare('INSERT INTO expenses (house_id, date, vendor, amount, category, confidence, photo_r2_key, raw_text, logged_by_phone, notes, sheet_row) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(houseId, date, vendor, amount, category, confidence, photoR2Key, rawText, loggedByPhone, notes || '', sheetRow ?? null)
    .run();
  return result.meta.last_row_id;
}

export async function insertPendingReview(db, { clientId, houseId, amountGuess, categoryGuess, photoR2Key, rawText, confidence, expiresAt }) {
  const result = await db
    .prepare('INSERT INTO pending_review (client_id, house_id, amount_guess, category_guess, photo_r2_key, raw_text, confidence, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(clientId, houseId, amountGuess, categoryGuess, photoR2Key, rawText, confidence, expiresAt)
    .run();
  return result.meta.last_row_id;
}

export async function findPendingReviewById(db, id) {
  return db.prepare('SELECT * FROM pending_review WHERE id = ?').bind(id).first();
}

export async function deletePendingReview(db, id) {
  return db.prepare('DELETE FROM pending_review WHERE id = ?').bind(id).run();
}

export async function findExpenseById(db, id) {
  return db.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first();
}

export async function updateExpenseHouse(db, { expenseId, houseId, sheetRow }) {
  return db.prepare('UPDATE expenses SET house_id = ?, sheet_row = ? WHERE id = ?').bind(houseId, sheetRow, expenseId).run();
}
