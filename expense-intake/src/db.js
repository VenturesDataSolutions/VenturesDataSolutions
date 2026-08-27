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

export async function insertExpense(db, { houseId, date, vendor, amount, category, confidence, photoR2Key, rawText, loggedByPhone, loggedByEmail, notes, sheetRow }) {
  const result = await db
    .prepare('INSERT INTO expenses (house_id, date, vendor, amount, category, confidence, photo_r2_key, raw_text, logged_by_phone, logged_by_email, notes, sheet_row) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(houseId, date, vendor, amount, category, confidence, photoR2Key, rawText, loggedByPhone ?? null, loggedByEmail ?? null, notes || '', sheetRow ?? null)
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

export async function findOldestPendingReviewForClient(db, clientId) {
  return db.prepare('SELECT * FROM pending_review WHERE client_id = ? ORDER BY id ASC LIMIT 1').bind(clientId).first();
}

export async function findNextPendingReviewForClient(db, clientId, afterId) {
  return db.prepare('SELECT * FROM pending_review WHERE client_id = ? AND id > ? ORDER BY id ASC LIMIT 1').bind(clientId, afterId).first();
}

export async function deleteExpiredPendingReviews(db, nowIso) {
  const result = await db.prepare('DELETE FROM pending_review WHERE expires_at < ?').bind(nowIso).run();
  return result.meta.changes;
}

export async function findActiveClientsWithPendingCounts(db) {
  const result = await db
    .prepare("SELECT c.id AS client_id, c.twilio_number AS twilio_number, COUNT(pr.id) AS pending_count FROM clients c JOIN pending_review pr ON pr.client_id = c.id WHERE c.status = 'active' GROUP BY c.id")
    .all();
  return result.results;
}

export async function findAuthorizedSendersForClient(db, clientId) {
  const result = await db.prepare('SELECT * FROM authorized_senders WHERE client_id = ?').bind(clientId).all();
  return result.results;
}

export async function findClientById(db, id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
}

export async function findAuthorizedSenderByEmail(db, email) {
  return db.prepare('SELECT * FROM authorized_senders WHERE email = ?').bind(email).first();
}

export async function markContactCardSent(db, senderId, sentAtIso) {
  return db.prepare('UPDATE authorized_senders SET contact_card_sent_at = ? WHERE id = ?').bind(sentAtIso, senderId).run();
}

export async function insertSmsConsent(db, { phoneNumber, consentText, consentedAt }) {
  const result = await db
    .prepare('INSERT INTO sms_consents (phone_number, consent_text, consented_at) VALUES (?, ?, ?)')
    .bind(phoneNumber, consentText, consentedAt)
    .run();
  return result.meta.last_row_id;
}

export async function findSmsConsentByPhone(db, phoneNumber) {
  return db.prepare('SELECT * FROM sms_consents WHERE phone_number = ?').bind(phoneNumber).first();
}
