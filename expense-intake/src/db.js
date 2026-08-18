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

export async function insertExpense(db, { houseId, date, vendor, amount, category, confidence, photoR2Key, rawText, loggedByPhone, notes }) {
  return db
    .prepare('INSERT INTO expenses (house_id, date, vendor, amount, category, confidence, photo_r2_key, raw_text, logged_by_phone, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(houseId, date, vendor, amount, category, confidence, photoR2Key, rawText, loggedByPhone, notes || '')
    .run();
}

export async function insertPendingReview(db, { clientId, houseId, amountGuess, categoryGuess, photoR2Key, rawText, confidence, expiresAt }) {
  return db
    .prepare('INSERT INTO pending_review (client_id, house_id, amount_guess, category_guess, photo_r2_key, raw_text, confidence, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(clientId, houseId, amountGuess, categoryGuess, photoR2Key, rawText, confidence, expiresAt)
    .run();
}
