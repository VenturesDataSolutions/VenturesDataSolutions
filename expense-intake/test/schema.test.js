// expense-intake/test/schema.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(__dirname, '..', 'migrations', '0001_init.sql');

// Extracts the column-definition body of each `CREATE TABLE name (...)` block
// by counting parens, so it copes with nested parens inside CHECK(... IN (...)).
function extractTableBlocks(sql) {
  const blocks = {};
  const re = /CREATE TABLE (\w+) \(/g;
  let match;
  while ((match = re.exec(sql))) {
    const name = match[1];
    let i = re.lastIndex - 1;
    let depth = 0;
    const start = i;
    for (; i < sql.length; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks[name] = sql.slice(start + 1, i);
  }
  return blocks;
}

async function main() {
  assert(fs.existsSync(migrationPath), 'migrations/0001_init.sql missing');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const tables = extractTableBlocks(sql);

  const expectedTables = {
    clients: ['id', 'business_name', 'care_plan_tier', 'twilio_number', 'accounting_software', 'status', 'created_at'],
    authorized_senders: ['id', 'client_id', 'phone_number', 'label', 'contact_card_sent_at'],
    houses: ['id', 'client_id', 'address', 'nickname', 'google_sheet_id'],
    expenses: ['id', 'house_id', 'date', 'vendor', 'amount', 'category', 'confidence', 'photo_r2_key', 'raw_text', 'logged_by_phone', 'notes', 'created_at'],
    pending_review: ['id', 'client_id', 'house_id', 'amount_guess', 'category_guess', 'photo_r2_key', 'raw_text', 'confidence', 'created_at', 'expires_at'],
  };

  for (const [table, columns] of Object.entries(expectedTables)) {
    assert(tables[table], `migration must define CREATE TABLE ${table}`);
    for (const column of columns) {
      const re = new RegExp(`(^|[\\s(,])${column}\\s`, 'm');
      assert(re.test(tables[table]), `table ${table} must define column ${column}`);
    }
  }

  // accounting_software is a closed set per spec
  assert(/accounting_software TEXT NOT NULL CHECK \(accounting_software IN \('quickbooks_online', ?'quickbooks_desktop', ?'wave', ?'xero', ?'csv'\)\)/.test(tables.clients.replace(/\s+/g, ' ')),
    'clients.accounting_software must be constrained to the 5 known values');

  // the tax category taxonomy is locked — every category column must be constrained to exactly these 11 values
  const taxonomy = ['Materials', 'Labor/Contractor', 'Permits & Fees', 'Utilities', 'Insurance', 'Property Tax', 'Mortgage Interest', 'Repairs & Maintenance', 'Professional Services', 'Travel/Mileage', 'Other'];
  for (const cat of taxonomy) {
    assert(tables.expenses.includes(cat), `expenses.category CHECK must include taxonomy value "${cat}"`);
  }

  // foreign keys tie the tenant hierarchy together
  assert(/client_id INTEGER NOT NULL REFERENCES clients\(id\)/.test(tables.authorized_senders), 'authorized_senders.client_id must reference clients(id)');
  assert(/client_id INTEGER NOT NULL REFERENCES clients\(id\)/.test(tables.houses), 'houses.client_id must reference clients(id)');
  assert(/house_id INTEGER NOT NULL REFERENCES houses\(id\)/.test(tables.expenses), 'expenses.house_id must reference houses(id)');
  assert(/client_id INTEGER NOT NULL REFERENCES clients\(id\)/.test(tables.pending_review), 'pending_review.client_id must reference clients(id)');

  // indexes the later build steps will rely on
  assert(/CREATE UNIQUE INDEX.*clients\(twilio_number\)/.test(sql) || /twilio_number TEXT NOT NULL UNIQUE/.test(tables.clients), 'clients.twilio_number must be unique (Twilio "To" number identifies the client)');
  assert(/CREATE INDEX.*pending_review\(expires_at\)/.test(sql), 'pending_review needs an index on expires_at for the daily purge cron');
  assert(/CREATE UNIQUE INDEX.*authorized_senders\(client_id, ?phone_number\)/.test(sql), 'authorized_senders needs a unique index on (client_id, phone_number) for inbound sender lookup');

  console.log('PASS: schema.test.js');
}

await main();
