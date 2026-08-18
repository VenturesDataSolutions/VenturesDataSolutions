// expense-intake/test/migration-0002.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(__dirname, '..', 'migrations', '0002_add_sheet_row.sql');

async function main() {
  assert(fs.existsSync(migrationPath), 'migrations/0002_add_sheet_row.sql missing');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert(/ALTER TABLE expenses ADD COLUMN sheet_row INTEGER/.test(sql), 'migration must add an INTEGER sheet_row column to expenses, needed to delete/move the Sheet row on a house correction');

  console.log('PASS: migration-0002.test.js');
}

await main();
