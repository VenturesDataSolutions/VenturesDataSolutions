// expense-intake/test/migration-0004.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(__dirname, '..', 'migrations', '0004_add_email_identity.sql');

async function main() {
  assert(fs.existsSync(migrationPath), 'migrations/0004_add_email_identity.sql missing');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert(/CREATE TABLE authorized_senders_new/.test(sql), 'must recreate authorized_senders (SQLite cannot drop a NOT NULL constraint in place)');
  assert(/phone_number TEXT,/.test(sql), 'authorized_senders.phone_number must become nullable');
  assert(/email TEXT,/.test(sql), 'authorized_senders must gain an email column');
  assert(/CHECK \(phone_number IS NOT NULL OR email IS NOT NULL\)/.test(sql), 'authorized_senders must require at least one identity');
  assert(/CREATE UNIQUE INDEX idx_authorized_senders_email ON authorized_senders\(email\) WHERE email IS NOT NULL/.test(sql), 'email must be globally unique (a shared inbox has no per-client "To" signal, unlike SMS)');
  assert(/CREATE UNIQUE INDEX idx_authorized_senders_client_phone ON authorized_senders\(client_id, ?phone_number\)/.test(sql), 'the original (client_id, phone_number) unique index must be re-created after the table recreation');

  assert(/CREATE TABLE expenses_new/.test(sql), 'must recreate expenses (same NOT NULL relaxation need)');
  assert(/logged_by_phone TEXT,/.test(sql), 'expenses.logged_by_phone must become nullable');
  assert(/logged_by_email TEXT,/.test(sql), 'expenses must gain a logged_by_email column');
  assert(/CHECK \(logged_by_phone IS NOT NULL OR logged_by_email IS NOT NULL\)/.test(sql), 'expenses must require at least one identity');
  assert(/CREATE INDEX idx_expenses_house ON expenses\(house_id\)/.test(sql), 'the original expenses(house_id) index must be re-created after the table recreation');

  console.log('PASS: migration-0004.test.js');
}

await main();
