// expense-intake/test/migration-0003.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(__dirname, '..', 'migrations', '0003_add_sms_consents.sql');

async function main() {
  assert(fs.existsSync(migrationPath), 'migrations/0003_add_sms_consents.sql missing');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert(/CREATE TABLE sms_consents/.test(sql), 'migration must create the sms_consents table');
  assert(/phone_number TEXT NOT NULL/.test(sql), 'sms_consents.phone_number must be required');
  assert(/consent_text TEXT NOT NULL/.test(sql), 'sms_consents.consent_text must be required (the exact language agreed to)');
  assert(/consented_at TEXT NOT NULL/.test(sql), 'sms_consents.consented_at must be required (the proof timestamp)');
  assert(/CREATE INDEX.*sms_consents\(phone_number\)/.test(sql), 'sms_consents needs an index on phone_number for the onboarding consent-gate lookup');

  console.log('PASS: migration-0003.test.js');
}

await main();
