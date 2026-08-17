# Expense Intake Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Note on scope:** This plan is filled in incrementally, one Build Order step at a time, per explicit instruction from the project owner ("Start at step 1 and confirm with me before moving to step 2"). Only the tasks for the current Build Order step are written in full bite-sized detail; later steps are listed as placeholders in the Build Order Map below and get their own Task sections appended after each checkpoint is approved.
>
> **Note on commits:** Per working rule, the diff is shown to the project owner for review before anything is committed. Steps below say "stage the change" rather than "commit" — the actual `git commit` only happens after explicit approval, and only for the reviewed scope.

**Goal:** Build a multi-tenant SMS expense tracker for real estate investors (`expense-intake` Cloudflare Worker) — client texts a receipt photo or note to a dedicated number, the system parses/categorizes it, writes it to the right property's Google Sheet, and confirms by SMS. Phase 1 only (no contractor coordination, payment reminders, dashboard, or AI chat-edit layer).

**Architecture:** A standalone ES-module Cloudflare Worker in its own top-level folder `expense-intake/`, sibling to the existing `worker/` (which stays untouched — it owns county availability + Stripe, this is a separate deployable). Follows the same conventions already established in `worker/`: business logic as small pure modules that take dependencies (D1/KV/R2 bindings, fetch) as arguments so they're unit-testable under plain Node with zero npm dependencies (in-memory fakes for D1/KV/R2, no Miniflare/wrangler needed for the test suite); `src/index.js` as a thin routing layer; `test/run-all.js` importing every test file. Cloudflare D1 stores relational config/expense data, KV holds short-lived conversation state, R2 stores receipt photos, Cron Triggers run the purge/nudge jobs, and an internal provider-abstraction module fronts two swappable AI adapters (OpenRouter for dev, Anthropic direct for prod) selected by an `AI_PROVIDER` env var.

**Tech Stack:** Cloudflare Workers (ES modules), D1, KV, R2, Cron Triggers, Twilio SMS/MMS webhooks, Google Sheets API (service account), OpenRouter + Anthropic Messages API. No Stripe SDK equivalent needed here — REST calls via `fetch()` throughout, matching the existing worker's style. Tests are plain Node scripts, zero npm dependencies.

---

## Build Order Map (from spec)

1. **Repo scaffolding + wrangler config + D1 schema migration** ← this plan section
2. Provider abstraction with both adapters, tested standalone
3. Twilio inbound webhook → R2 photo storage
4. Parse → categorize → Sheets write → confirmation SMS (happy path)
5. House-selection flow + 10-minute correction window
6. Pending review queue + pending retrieval
7. Cron Triggers: daily purge, monthly nudge
8. Save-contact onboarding step
9. Onboarding CLI script

---

## Step 1: Repo scaffolding + wrangler config + D1 schema migration

### Task 1: Worker folder scaffold (package.json, wrangler.toml, stub entrypoint)

**Files:**
- Create: `expense-intake/package.json`
- Create: `expense-intake/wrangler.toml`
- Create: `expense-intake/src/index.js`
- Create: `expense-intake/test/index.test.js`
- Create: `expense-intake/test/run-all.js`
- Create: `expense-intake/README.md`

- [x] **Step 1: Write the failing test**

```js
// expense-intake/test/index.test.js
import workerModule from '../src/index.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  const request = new Request('https://expense-intake.example.com/', { method: 'GET' });
  const response = await workerModule.fetch(request, {});
  assert(response.status === 404, 'unrouted requests should 404 until later build steps add real routes');

  console.log('PASS: index.test.js');
}

await main();
```

```js
// expense-intake/test/run-all.js
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/run-all.js`
Expected: fails with a module-not-found error for `../src/index.js` (it doesn't exist yet).

- [x] **Step 3: Write the scaffold files**

```json
// expense-intake/package.json
{
  "name": "expense-intake",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node test/run-all.js",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^4.0.0"
  }
}
```

```toml
# expense-intake/wrangler.toml
name = "expense-intake"
main = "src/index.js"
compatibility_date = "2026-08-17"

[[d1_databases]]
binding = "DB"
database_name = "expense-intake-db"
database_id = "REPLACE_WITH_D1_DATABASE_ID"

[vars]
AI_PROVIDER = "openrouter"

# KV namespace (conversation state: house-selection pending, correction window),
# R2 bucket (receipt photos), routes, and [[triggers]] cron entries are added in
# later Build Order steps (3, 5-7) once the code that uses them exists.
```

```js
// expense-intake/src/index.js
export default {
  async fetch(request, env) {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
```

```markdown
// expense-intake/README.md
# Expense Intake Worker

Cloudflare Worker that powers the multi-tenant SMS expense tracker for real
estate investors: client texts a receipt to a dedicated Twilio number, the
Worker parses/categorizes it, writes it to the property's Google Sheet, and
texts back a confirmation. Deploys independently of `worker/` (Stripe/county
availability) and of the static site.

See `docs/superpowers/plans/2026-08-17-expense-intake-worker.md` for the
implementation plan and Build Order.

## Status

Build Order step 1 only so far: repo scaffolding, `wrangler.toml`, and the D1
schema migration. No routes are wired up yet — every request 404s.

## Running the Worker's own tests

\`\`\`bash
cd expense-intake
node test/run-all.js
\`\`\`

Zero npm dependencies, same pattern as `worker/`: plain Node scripts exercise
pure logic modules with in-memory fakes, no Miniflare/wrangler required.

## D1 setup (one-time, per environment)

\`\`\`bash
npx wrangler d1 create expense-intake-db
\`\`\`

Paste the printed `database_id` into `wrangler.toml`, replacing
`REPLACE_WITH_D1_DATABASE_ID`. Then apply the schema:

\`\`\`bash
npx wrangler d1 execute expense-intake-db --file=migrations/0001_init.sql          # remote
npx wrangler d1 execute expense-intake-db --local --file=migrations/0001_init.sql  # local dev
\`\`\`
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: `PASS: index.test.js` then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 5: Stage the change (do not commit yet — held for review)**

```bash
git add expense-intake/package.json expense-intake/wrangler.toml expense-intake/src/index.js expense-intake/test/index.test.js expense-intake/test/run-all.js expense-intake/README.md
```

---

### Task 2: D1 schema migration

**Files:**
- Create: `expense-intake/migrations/0001_init.sql`
- Test: `expense-intake/test/schema.test.js`
- Modify: `expense-intake/test/run-all.js`

The spec's DATA MODEL section is pseudo-SQL; this task translates it into real
SQLite DDL (D1 is SQLite-compatible) with explicit types, the locked tax
category taxonomy as a `CHECK` constraint, foreign keys, and indexes that the
later Build Order steps will actually query by (inbound lookup by Twilio
number + sender phone, pending-review purge by `expires_at`, Sheet rows by
`house_id`).

- [x] **Step 1: Write the failing test**

```js
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
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/schema.test.js`
Expected: fails with `Error: migrations/0001_init.sql missing`

- [x] **Step 3: Write the migration**

```sql
-- expense-intake/migrations/0001_init.sql

CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT NOT NULL,
  care_plan_tier TEXT,
  twilio_number TEXT NOT NULL UNIQUE,
  accounting_software TEXT NOT NULL CHECK (accounting_software IN ('quickbooks_online', 'quickbooks_desktop', 'wave', 'xero', 'csv')),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE authorized_senders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  phone_number TEXT NOT NULL,
  label TEXT,
  contact_card_sent_at TEXT
);

CREATE UNIQUE INDEX idx_authorized_senders_client_phone ON authorized_senders(client_id, phone_number);

CREATE TABLE houses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  address TEXT NOT NULL,
  nickname TEXT,
  google_sheet_id TEXT
);

CREATE INDEX idx_houses_client ON houses(client_id);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  house_id INTEGER NOT NULL REFERENCES houses(id),
  date TEXT NOT NULL,
  vendor TEXT,
  amount REAL,
  category TEXT NOT NULL CHECK (category IN ('Materials', 'Labor/Contractor', 'Permits & Fees', 'Utilities', 'Insurance', 'Property Tax', 'Mortgage Interest', 'Repairs & Maintenance', 'Professional Services', 'Travel/Mileage', 'Other')),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  photo_r2_key TEXT,
  raw_text TEXT,
  logged_by_phone TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX idx_expenses_house ON expenses(house_id);

CREATE TABLE pending_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  house_id INTEGER REFERENCES houses(id),
  amount_guess REAL,
  category_guess TEXT CHECK (category_guess IS NULL OR category_guess IN ('Materials', 'Labor/Contractor', 'Permits & Fees', 'Utilities', 'Insurance', 'Property Tax', 'Mortgage Interest', 'Repairs & Maintenance', 'Professional Services', 'Travel/Mileage', 'Other')),
  photo_r2_key TEXT,
  raw_text TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_pending_review_client ON pending_review(client_id);
CREATE INDEX idx_pending_review_expires ON pending_review(expires_at);
```

`house_id` is nullable on `pending_review` (unlike `expenses`, where it's
required): a low-confidence item can land in the queue before the house is
even known, since house-selection ambiguity and parse-confidence ambiguity
are independent failure modes in the spec's MESSAGE FLOW.

- [x] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 5: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: `PASS: schema.test.js`, `PASS: index.test.js`, `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Validate the migration against real D1 SQLite (local emulation)**

```bash
cd expense-intake
npm install
npx wrangler d1 execute expense-intake-db --local --file=migrations/0001_init.sql
npx wrangler d1 execute expense-intake-db --local --command="SELECT name FROM sqlite_master WHERE type='table'"
```

Expected: no SQL errors; the second command lists all 5 tables. This exercises
the real SQLite engine D1 runs on (via Wrangler's local emulation, no network
or remote database needed) — the plain-Node test above only checks the SQL
text structurally, this confirms it actually executes.

- [x] **Step 7: Stage the change (do not commit yet — held for review)**

```bash
git add expense-intake/migrations/0001_init.sql expense-intake/test/schema.test.js expense-intake/test/run-all.js
```

---

## Self-Review — Step 1

**Spec coverage for Step 1:** "Repo scaffolding" → Task 1. "wrangler config" → Task 1 (`wrangler.toml` with `AI_PROVIDER` defaulted to `openrouter` per spec; D1 binding present; KV/R2/routes/cron deferred to the steps that need them, called out explicitly in a comment so it's not mistaken for an oversight). "D1 schema migration" → Task 2, covering all 6 tables named in the spec's DATA MODEL section (note: the spec lists 5 tables plus implies `expenses`/`pending_review` — all 5 distinct tables from the spec are present: `clients`, `authorized_senders`, `houses`, `expenses`, `pending_review`) with the locked tax taxonomy and `accounting_software` enum enforced as `CHECK` constraints so bad values fail at the database layer, not just in application code.

**Placeholder scan:** No TBD/TODO markers. `REPLACE_WITH_D1_DATABASE_ID` is an intentional, documented placeholder (the real ID only exists after `wrangler d1 create` is run against the actual Cloudflare account, which requires the project owner's login) — the README spells out the exact command to replace it, matching the existing `worker/README.md` pattern for `COUNTY_LOCKS`.

**Type consistency:** `src/index.js`'s stub `fetch` signature `(request, env)` matches what later steps' router will extend. Column names in `schema.test.js` match the migration exactly (both hand-checked against the spec's DATA MODEL block).

---

## Step 2: Provider abstraction with both adapters, tested standalone

**Interface (from spec):**
```
parseExpense(input) -> { vendor, amount, category, confidence, raw_text }
generateSmsCopy(type, vars) -> string
```

**Design decisions locked in for this step:**
- `parseExpense(input, env, deps)` and `generateSmsCopy(type, vars, env, deps)` — the spec's two-argument signature is the *conceptual* interface; in Worker code, secrets only exist on `env`, so both public functions take `env` (for `AI_PROVIDER`/`ANTHROPIC_API_KEY`/`OPENROUTER_API_KEY`) and an optional `deps.fetchImpl` for test injection, matching the `fetchImpl` pattern already used in `worker/src/stripe.js`. No caller outside `src/providers/index.js` ever branches on which provider is active — that satisfies the spec's "no other code in the project should know which provider is active."
- `input` for `parseExpense` is `{ text, image }` where `image` is `{ base64, mediaType }` (or omitted/`null` for text-only messages). Both adapters accept this same shape.
- OpenRouter adapter is pinned to model string `anthropic/claude-sonnet-4.5` (per spec, verbatim). The Anthropic direct adapter is pinned to `claude-sonnet-4-5-20250929` — the dated native-API model ID for the same underlying model, confirmed with the project owner since the spec only pinned the OpenRouter slug.
- `AI_PROVIDER` unset or any value other than `'anthropic'` defaults to `'openrouter'`, per spec ("Default the env var to openrouter for now").
- Image preprocessing (resize/recompress to R2) happens in Build Order step 3, before `parseExpense` is ever called — this step's adapters just accept already-prepared `{ base64, mediaType }` and are tested with small fixture image data, not real photos.
- Model output is required to be strict JSON with exactly the five spec'd keys. If the model returns an invalid category, non-numeric amount/confidence, or unparseable JSON, `normalizeParseExpenseResult`/`extractJsonBlock` throw — this step does not decide what happens on failure (e.g. falling back to `pending_review`); that's a routing decision for Build Order step 4, which will catch and handle it.

### Task 3: Shared provider module (taxonomy, prompts, JSON parsing/validation)

**Files:**
- Create: `expense-intake/src/providers/shared.js`
- Create: `expense-intake/test/providers/shared.test.js`
- Modify: `expense-intake/test/run-all.js`

This module is imported by both adapters so the taxonomy, prompt wording, and output validation live in exactly one place (DRY) — an OpenRouter-only bug in categorization logic would otherwise be impossible to distinguish from an Anthropic-only one.

- [ ] **Step 1: Write the failing test**

```js
// expense-intake/test/providers/shared.test.js
import {
  TAX_CATEGORIES,
  PARSE_EXPENSE_SYSTEM_PROMPT,
  SMS_COPY_ANCHORS,
  buildSmsCopyPrompt,
  extractJsonBlock,
  normalizeParseExpenseResult,
  ProviderParseError,
} from '../../src/providers/shared.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  // TAX_CATEGORIES: the locked taxonomy, exact set and order-independent match
  const expectedTaxonomy = ['Materials', 'Labor/Contractor', 'Permits & Fees', 'Utilities', 'Insurance', 'Property Tax', 'Mortgage Interest', 'Repairs & Maintenance', 'Professional Services', 'Travel/Mileage', 'Other'];
  assert(TAX_CATEGORIES.length === 11, 'TAX_CATEGORIES must have exactly 11 entries');
  for (const cat of expectedTaxonomy) {
    assert(TAX_CATEGORIES.includes(cat), `TAX_CATEGORIES must include "${cat}"`);
  }

  // PARSE_EXPENSE_SYSTEM_PROMPT: must instruct JSON-only output with the right keys
  assert(PARSE_EXPENSE_SYSTEM_PROMPT.includes('vendor'), 'parse prompt must mention vendor');
  assert(PARSE_EXPENSE_SYSTEM_PROMPT.includes('amount'), 'parse prompt must mention amount');
  assert(PARSE_EXPENSE_SYSTEM_PROMPT.includes('category'), 'parse prompt must mention category');
  assert(PARSE_EXPENSE_SYSTEM_PROMPT.includes('confidence'), 'parse prompt must mention confidence');
  assert(PARSE_EXPENSE_SYSTEM_PROMPT.includes('raw_text'), 'parse prompt must mention raw_text');
  assert(PARSE_EXPENSE_SYSTEM_PROMPT.includes('Materials'), 'parse prompt must enumerate the locked taxonomy');
  assert(/JSON/i.test(PARSE_EXPENSE_SYSTEM_PROMPT), 'parse prompt must instruct JSON-only output');

  // SMS_COPY_ANCHORS: the four message types from the spec, each with its few-shot examples
  assert(SMS_COPY_ANCHORS.confirmation.length === 3, 'confirmation must have 3 tone anchors');
  assert(SMS_COPY_ANCHORS.house_selection.length === 2, 'house_selection must have 2 tone anchors');
  assert(SMS_COPY_ANCHORS.low_confidence.length === 2, 'low_confidence must have 2 tone anchors');
  assert(SMS_COPY_ANCHORS.monthly_nudge.length === 1, 'monthly_nudge must have 1 tone anchor');

  // buildSmsCopyPrompt: injects vars and anchors, rejects unknown types
  const { system, user } = buildSmsCopyPrompt('confirmation', { amount: '42.50', category: 'Materials', house: '123 Main St' });
  assert(system.includes('Logged: $[amount]'), 'confirmation prompt must include its tone anchors');
  assert(system.includes('do not copy'), 'prompt must instruct the model not to copy anchors verbatim');
  assert(user.includes('amount: 42.50') && user.includes('house: 123 Main St'), 'user message must carry the actual variable values');
  let threwUnknownType = false;
  try { buildSmsCopyPrompt('not_a_real_type', {}); } catch { threwUnknownType = true; }
  assert(threwUnknownType, 'buildSmsCopyPrompt must reject unknown message types');

  // extractJsonBlock: plain JSON, fenced JSON, and failure case
  const plain = extractJsonBlock('{"vendor":"Home Depot","amount":42.5,"category":"Materials","confidence":0.9,"raw_text":"HD $42.50"}');
  assert(plain.vendor === 'Home Depot', 'extractJsonBlock must parse plain JSON');
  const fenced = extractJsonBlock('Here you go:\n```json\n{"vendor":"Lowes","amount":10,"category":"Materials","confidence":0.5,"raw_text":"x"}\n```');
  assert(fenced.vendor === 'Lowes', 'extractJsonBlock must strip markdown code fences');
  let threwNoJson = false;
  try { extractJsonBlock('no json here'); } catch { threwNoJson = true; }
  assert(threwNoJson, 'extractJsonBlock must throw when no JSON object is present');

  // normalizeParseExpenseResult: happy path
  const good = normalizeParseExpenseResult({ vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.87, raw_text: 'HD $42.50' });
  assert(good.vendor === 'Home Depot' && good.amount === 42.5 && good.category === 'Materials' && good.confidence === 0.87 && good.raw_text === 'HD $42.50', 'normalizeParseExpenseResult must pass through valid fields unchanged');

  // normalizeParseExpenseResult: null vendor/amount allowed
  const nulls = normalizeParseExpenseResult({ vendor: null, amount: null, category: 'Other', confidence: 0.2, raw_text: 'unclear' });
  assert(nulls.vendor === null && nulls.amount === null, 'vendor and amount may be null when not determinable');

  // normalizeParseExpenseResult: confidence is clamped to [0, 1]
  const clampedHigh = normalizeParseExpenseResult({ vendor: null, amount: null, category: 'Other', confidence: 1.4, raw_text: '' });
  assert(clampedHigh.confidence === 1, 'confidence above 1 must be clamped to 1');
  const clampedLow = normalizeParseExpenseResult({ vendor: null, amount: null, category: 'Other', confidence: -0.3, raw_text: '' });
  assert(clampedLow.confidence === 0, 'confidence below 0 must be clamped to 0');

  // normalizeParseExpenseResult: invalid category throws ProviderParseError
  let threwBadCategory = false;
  try {
    normalizeParseExpenseResult({ vendor: null, amount: null, category: 'Snacks', confidence: 0.5, raw_text: '' });
  } catch (err) {
    threwBadCategory = true;
    assert(err instanceof ProviderParseError, 'invalid category must throw ProviderParseError');
  }
  assert(threwBadCategory, 'category outside the locked taxonomy must throw');

  // normalizeParseExpenseResult: non-numeric amount throws
  let threwBadAmount = false;
  try {
    normalizeParseExpenseResult({ vendor: null, amount: '42.50', category: 'Other', confidence: 0.5, raw_text: '' });
  } catch { threwBadAmount = true; }
  assert(threwBadAmount, 'a string amount must throw (model must return a number, not a string)');

  console.log('PASS: providers/shared.test.js');
}

await main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/providers/shared.test.js`
Expected: fails with a module-not-found error for `../../src/providers/shared.js` (it doesn't exist yet).

- [ ] **Step 3: Write the shared module**

```js
// expense-intake/src/providers/shared.js

export const TAX_CATEGORIES = [
  'Materials',
  'Labor/Contractor',
  'Permits & Fees',
  'Utilities',
  'Insurance',
  'Property Tax',
  'Mortgage Interest',
  'Repairs & Maintenance',
  'Professional Services',
  'Travel/Mileage',
  'Other',
];

export const PARSE_EXPENSE_SYSTEM_PROMPT = `You are an expense-parsing assistant for a real estate investment property expense tracker.

Given either a photo of a receipt, free-form text describing an expense, or both, extract:
- vendor: the business/vendor name, or null if not determinable
- amount: the total amount in dollars as a number (no currency symbol), or null if not determinable
- category: exactly one of these tax categories (use "Other" if none fit): ${TAX_CATEGORIES.join(', ')}
- confidence: a number from 0 to 1 representing how confident you are that the vendor, amount, and category are all correct
- raw_text: the verbatim text visible on the receipt or sent by the client, as plain text

Respond with ONLY a single JSON object with exactly these five keys (vendor, amount, category, confidence, raw_text) and no other text, markdown, or code fences.`;

export const SMS_COPY_ANCHORS = {
  confirmation: [
    'Logged: $[amount], [category], [house]. Reply within 10 min to correct.',
    '$[amount] recorded under [category] for [house]. 10-minute window if this needs a fix.',
    '[house] — $[amount], [category]. Saved. Flag it in the next 10 min if the house is wrong.',
  ],
  house_selection: [
    'Which house is this for? Address or nickname works.',
    "Couldn't tell which property — which one's this for?",
  ],
  low_confidence: [
    "Logged this as [category] but wasn't fully sure — flagged it for you to double check.",
    'Saved under [category] — photo was a little unclear so I flagged it for review.',
  ],
  monthly_nudge: [
    "[X] items waiting on your OK. Text 'pending' to review.",
  ],
};

export function buildSmsCopyPrompt(type, vars) {
  const anchors = SMS_COPY_ANCHORS[type];
  if (!anchors) {
    throw new Error(`Unknown SMS copy type: ${type}`);
  }
  const varLines = Object.entries(vars || {}).map(([key, value]) => `- ${key}: ${value}`).join('\n');
  const system = `You write outbound SMS copy for a business-facing expense-tracking service used by real estate investors. The tone is professional and businesslike, never casual or chatty.

Below are example messages for this message type. They are tone and style anchors only — do not copy any of them verbatim. Generate a fresh message that varies its wording so a repeat client does not see the identical string every time, while keeping the same meaning and tone.

Examples:
${anchors.map((example) => `- ${example}`).join('\n')}

Substitute in the actual values provided below instead of the bracketed placeholders. Respond with ONLY the SMS message text — no quotes, no markdown, no explanation.`;
  const user = varLines ? `Values to use:\n${varLines}` : 'No values needed for this message type.';
  return { system, user };
}

export function extractJsonBlock(text) {
  if (typeof text !== 'string') {
    throw new Error('extractJsonBlock expected a string');
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON object found in model response');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export class ProviderParseError extends Error {}

export function normalizeParseExpenseResult(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ProviderParseError('Model response is not a JSON object');
  }
  const { vendor, amount, category, confidence, raw_text } = raw;

  if (vendor !== null && vendor !== undefined && typeof vendor !== 'string') {
    throw new ProviderParseError('vendor must be a string or null');
  }
  if (amount !== null && amount !== undefined && typeof amount !== 'number') {
    throw new ProviderParseError('amount must be a number or null');
  }
  if (typeof category !== 'string' || !TAX_CATEGORIES.includes(category)) {
    throw new ProviderParseError(`category must be one of the locked taxonomy values, got: ${category}`);
  }
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) {
    throw new ProviderParseError('confidence must be a number');
  }
  if (typeof raw_text !== 'string') {
    throw new ProviderParseError('raw_text must be a string');
  }

  return {
    vendor: vendor ?? null,
    amount: amount ?? null,
    category,
    confidence: Math.min(1, Math.max(0, confidence)),
    raw_text,
  };
}
```

- [ ] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: `PASS: schema.test.js`, `PASS: providers/shared.test.js`, `PASS: index.test.js`, `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [ ] **Step 6: Stage the change (do not commit yet — held for review)**

```bash
git add expense-intake/src/providers/shared.js expense-intake/test/providers/shared.test.js expense-intake/test/run-all.js
```

---

### Task 4: OpenRouter adapter

**Files:**
- Create: `expense-intake/src/providers/openrouter.js`
- Create: `expense-intake/test/providers/openrouter.test.js`
- Modify: `expense-intake/test/run-all.js`

OpenAI-compatible chat completions schema, model pinned to `anthropic/claude-sonnet-4.5` per spec. Used for development (`AI_PROVIDER=openrouter`, the default).

- [ ] **Step 1: Write the failing test**

```js
// expense-intake/test/providers/openrouter.test.js
import { openRouterParseExpense, openRouterGenerateSmsCopy } from '../../src/providers/openrouter.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function fakeFetch(responseBody, status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => responseBody };
  };
  fn.calls = calls;
  return fn;
}

function chatResponse(content) {
  return { choices: [{ message: { content } }] };
}

async function main() {
  // parseExpense, text-only input
  const textFetch = fakeFetch(chatResponse('{"vendor":"Home Depot","amount":42.5,"category":"Materials","confidence":0.9,"raw_text":"HD $42.50"}'));
  const result = await openRouterParseExpense({ apiKey: 'or_key', text: 'Home Depot $42.50 for lumber', image: null, fetchImpl: textFetch });
  assert(result.vendor === 'Home Depot', 'openRouterParseExpense must return the normalized parsed result');
  const call = textFetch.calls[0];
  assert(call.url === 'https://openrouter.ai/api/v1/chat/completions', 'must hit the OpenRouter chat completions endpoint');
  assert(call.init.headers.Authorization === 'Bearer or_key', 'must send the OpenRouter API key as a Bearer token');
  const body = JSON.parse(call.init.body);
  assert(body.model === 'anthropic/claude-sonnet-4.5', 'must pin the spec-required OpenRouter model string');
  assert(body.messages[0].role === 'system', 'first message must be the system prompt');
  assert(body.messages[1].content[0].type === 'text' && body.messages[1].content[0].text.includes('Home Depot'), 'text-only input must send a text content block');
  assert(body.messages[1].content.length === 1, 'text-only input must not include an image_url block');

  // parseExpense, with an image
  const imageFetch = fakeFetch(chatResponse('{"vendor":null,"amount":null,"category":"Other","confidence":0.3,"raw_text":"blurry receipt"}'));
  await openRouterParseExpense({ apiKey: 'or_key', text: null, image: { base64: 'ZmFrZWJhc2U2NA==', mediaType: 'image/jpeg' }, fetchImpl: imageFetch });
  const imageBody = JSON.parse(imageFetch.calls[0].init.body);
  const imageBlock = imageBody.messages[1].content.find((block) => block.type === 'image_url');
  assert(imageBlock, 'image input must send an image_url content block');
  assert(imageBlock.image_url.url === 'data:image/jpeg;base64,ZmFrZWJhc2U2NA==', 'image_url must be a base64 data URI with the correct media type');

  // parseExpense error path
  const failFetch = fakeFetch({ error: { message: 'Invalid API key' } }, 401);
  let threw = false;
  try {
    await openRouterParseExpense({ apiKey: 'bad', text: 'x', image: null, fetchImpl: failFetch });
  } catch (err) {
    threw = true;
    assert(err.message === 'Invalid API key', 'must surface the OpenRouter error message');
  }
  assert(threw, 'a non-2xx OpenRouter response must throw');

  // generateSmsCopy
  const smsFetch = fakeFetch(chatResponse('$42.50 recorded under Materials for 123 Main St. 10-minute window if this needs a fix.'));
  const sms = await openRouterGenerateSmsCopy({ apiKey: 'or_key', type: 'confirmation', vars: { amount: '42.50', category: 'Materials', house: '123 Main St' }, fetchImpl: smsFetch });
  assert(sms === '$42.50 recorded under Materials for 123 Main St. 10-minute window if this needs a fix.', 'generateSmsCopy must return the trimmed model output');
  const smsBody = JSON.parse(smsFetch.calls[0].init.body);
  assert(smsBody.temperature > 0.5, 'SMS copy generation must use a nonzero temperature for wording variation');

  console.log('PASS: providers/openrouter.test.js');
}

await main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/providers/openrouter.test.js`
Expected: fails with a module-not-found error for `../../src/providers/openrouter.js`.

- [ ] **Step 3: Write the adapter**

```js
// expense-intake/src/providers/openrouter.js
import { PARSE_EXPENSE_SYSTEM_PROMPT, buildSmsCopyPrompt, extractJsonBlock, normalizeParseExpenseResult } from './shared.js';

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5';

function buildUserContent(text, image) {
  const content = [];
  if (text) {
    content.push({ type: 'text', text });
  }
  if (image) {
    content.push({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } });
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }
  return content;
}

async function openRouterChatCompletion({ apiKey, messages, temperature, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const response = await doFetch(`${OPENROUTER_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages, temperature }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.error && data.error.message) || `OpenRouter request failed with status ${response.status}`;
    throw new Error(message);
  }
  return data.choices[0].message.content;
}

export async function openRouterParseExpense({ apiKey, text, image, fetchImpl }) {
  const messages = [
    { role: 'system', content: PARSE_EXPENSE_SYSTEM_PROMPT },
    { role: 'user', content: buildUserContent(text, image) },
  ];
  const content = await openRouterChatCompletion({ apiKey, messages, temperature: 0, fetchImpl });
  return normalizeParseExpenseResult(extractJsonBlock(content));
}

export async function openRouterGenerateSmsCopy({ apiKey, type, vars, fetchImpl }) {
  const { system, user } = buildSmsCopyPrompt(type, vars);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const content = await openRouterChatCompletion({ apiKey, messages, temperature: 0.9, fetchImpl });
  return content.trim();
}
```

- [ ] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: all four test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [ ] **Step 6: Stage the change (do not commit yet — held for review)**

```bash
git add expense-intake/src/providers/openrouter.js expense-intake/test/providers/openrouter.test.js expense-intake/test/run-all.js
```

---

### Task 5: Anthropic direct adapter

**Files:**
- Create: `expense-intake/src/providers/anthropic.js`
- Create: `expense-intake/test/providers/anthropic.test.js`
- Modify: `expense-intake/test/run-all.js`

Native Messages API against `api.anthropic.com`, model pinned to `claude-sonnet-4-5-20250929` (confirmed with project owner — see Design decisions above). Used in production (`AI_PROVIDER=anthropic`).

- [ ] **Step 1: Write the failing test**

```js
// expense-intake/test/providers/anthropic.test.js
import { anthropicParseExpense, anthropicGenerateSmsCopy } from '../../src/providers/anthropic.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function fakeFetch(responseBody, status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => responseBody };
  };
  fn.calls = calls;
  return fn;
}

function messagesResponse(text) {
  return { content: [{ type: 'text', text }] };
}

async function main() {
  // parseExpense, text-only input
  const textFetch = fakeFetch(messagesResponse('{"vendor":"Home Depot","amount":42.5,"category":"Materials","confidence":0.9,"raw_text":"HD $42.50"}'));
  const result = await anthropicParseExpense({ apiKey: 'sk-ant-key', text: 'Home Depot $42.50 for lumber', image: null, fetchImpl: textFetch });
  assert(result.vendor === 'Home Depot', 'anthropicParseExpense must return the normalized parsed result');
  const call = textFetch.calls[0];
  assert(call.url === 'https://api.anthropic.com/v1/messages', 'must hit the Anthropic native Messages endpoint');
  assert(call.init.headers['x-api-key'] === 'sk-ant-key', 'must send the Anthropic API key via x-api-key');
  assert(call.init.headers['anthropic-version'], 'must send an anthropic-version header');
  const body = JSON.parse(call.init.body);
  assert(body.model === 'claude-sonnet-4-5-20250929', 'must pin the confirmed native Anthropic model ID');
  assert(body.system.includes('vendor'), 'system field must carry the parse-expense system prompt');
  assert(body.messages[0].content[0].type === 'text' && body.messages[0].content[0].text.includes('Home Depot'), 'text-only input must send a text content block');
  assert(body.messages[0].content.length === 1, 'text-only input must not include an image block');

  // parseExpense, with an image (image block must precede text, per Anthropic's recommended ordering)
  const imageFetch = fakeFetch(messagesResponse('{"vendor":null,"amount":null,"category":"Other","confidence":0.3,"raw_text":"blurry receipt"}'));
  await anthropicParseExpense({ apiKey: 'sk-ant-key', text: 'no note', image: { base64: 'ZmFrZWJhc2U2NA==', mediaType: 'image/jpeg' }, fetchImpl: imageFetch });
  const imageBody = JSON.parse(imageFetch.calls[0].init.body);
  const imageBlock = imageBody.messages[0].content.find((block) => block.type === 'image');
  assert(imageBlock, 'image input must send an image content block');
  assert(imageBlock.source.type === 'base64' && imageBlock.source.media_type === 'image/jpeg' && imageBlock.source.data === 'ZmFrZWJhc2U2NA==', 'image block must carry base64 source data and media type');

  // parseExpense error path
  const failFetch = fakeFetch({ error: { message: 'invalid x-api-key' } }, 401);
  let threw = false;
  try {
    await anthropicParseExpense({ apiKey: 'bad', text: 'x', image: null, fetchImpl: failFetch });
  } catch (err) {
    threw = true;
    assert(err.message === 'invalid x-api-key', 'must surface the Anthropic error message');
  }
  assert(threw, 'a non-2xx Anthropic response must throw');

  // generateSmsCopy
  const smsFetch = fakeFetch(messagesResponse('$42.50 recorded under Materials for 123 Main St. 10-minute window if this needs a fix.'));
  const sms = await anthropicGenerateSmsCopy({ apiKey: 'sk-ant-key', type: 'confirmation', vars: { amount: '42.50', category: 'Materials', house: '123 Main St' }, fetchImpl: smsFetch });
  assert(sms === '$42.50 recorded under Materials for 123 Main St. 10-minute window if this needs a fix.', 'generateSmsCopy must return the trimmed model output');
  const smsBody = JSON.parse(smsFetch.calls[0].init.body);
  assert(smsBody.temperature > 0.5, 'SMS copy generation must use a nonzero temperature for wording variation');

  console.log('PASS: providers/anthropic.test.js');
}

await main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/providers/anthropic.test.js`
Expected: fails with a module-not-found error for `../../src/providers/anthropic.js`.

- [ ] **Step 3: Write the adapter**

```js
// expense-intake/src/providers/anthropic.js
import { PARSE_EXPENSE_SYSTEM_PROMPT, buildSmsCopyPrompt, extractJsonBlock, normalizeParseExpenseResult } from './shared.js';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';

function buildUserContent(text, image) {
  const content = [];
  if (image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } });
  }
  if (text) {
    content.push({ type: 'text', text });
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }
  return content;
}

async function anthropicMessagesRequest({ apiKey, system, messages, temperature, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const response = await doFetch(`${ANTHROPIC_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, system, max_tokens: 1024, temperature, messages }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.error && data.error.message) || `Anthropic request failed with status ${response.status}`;
    throw new Error(message);
  }
  return data.content[0].text;
}

export async function anthropicParseExpense({ apiKey, text, image, fetchImpl }) {
  const messages = [{ role: 'user', content: buildUserContent(text, image) }];
  const content = await anthropicMessagesRequest({ apiKey, system: PARSE_EXPENSE_SYSTEM_PROMPT, messages, temperature: 0, fetchImpl });
  return normalizeParseExpenseResult(extractJsonBlock(content));
}

export async function anthropicGenerateSmsCopy({ apiKey, type, vars, fetchImpl }) {
  const { system, user } = buildSmsCopyPrompt(type, vars);
  const messages = [{ role: 'user', content: user }];
  const content = await anthropicMessagesRequest({ apiKey, system, messages, temperature: 0.9, fetchImpl });
  return content.trim();
}
```

- [ ] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: all five test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [ ] **Step 6: Stage the change (do not commit yet — held for review)**

```bash
git add expense-intake/src/providers/anthropic.js expense-intake/test/providers/anthropic.test.js expense-intake/test/run-all.js
```

---

### Task 6: Provider selector driven by `AI_PROVIDER`

**Files:**
- Create: `expense-intake/src/providers/index.js`
- Create: `expense-intake/test/providers/index.test.js`
- Modify: `expense-intake/test/run-all.js`
- Modify: `expense-intake/README.md`

This is the only module the rest of the Worker ever imports from `src/providers/` — it reads `env.AI_PROVIDER` and dispatches to whichever adapter is active, so no other code needs to know OpenRouter and Anthropic adapters exist at all.

- [ ] **Step 1: Write the failing test**

```js
// expense-intake/test/providers/index.test.js
import { parseExpense, generateSmsCopy } from '../../src/providers/index.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function fakeFetch(responseBody, status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => responseBody };
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  const parsedJson = '{"vendor":"Home Depot","amount":42.5,"category":"Materials","confidence":0.9,"raw_text":"HD $42.50"}';

  // Default (AI_PROVIDER unset) must route to OpenRouter, per spec
  const defaultFetch = fakeFetch({ choices: [{ message: { content: parsedJson } }] });
  await parseExpense({ text: 'HD $42.50', image: null }, {
    OPENROUTER_API_KEY: 'or_key', ANTHROPIC_API_KEY: 'ant_key',
  }, { fetchImpl: defaultFetch });
  assert(defaultFetch.calls[0].url === 'https://openrouter.ai/api/v1/chat/completions', 'unset AI_PROVIDER must default to OpenRouter');
  assert(defaultFetch.calls[0].init.headers.Authorization === 'Bearer or_key', 'default routing must use OPENROUTER_API_KEY');

  // AI_PROVIDER=openrouter explicitly
  const orFetch = fakeFetch({ choices: [{ message: { content: parsedJson } }] });
  await parseExpense({ text: 'HD $42.50', image: null }, {
    AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or_key', ANTHROPIC_API_KEY: 'ant_key',
  }, { fetchImpl: orFetch });
  assert(orFetch.calls[0].url === 'https://openrouter.ai/api/v1/chat/completions', 'AI_PROVIDER=openrouter must route to OpenRouter');

  // AI_PROVIDER=anthropic must route to Anthropic direct
  const antFetch = fakeFetch({ content: [{ type: 'text', text: parsedJson }] });
  const result = await parseExpense({ text: 'HD $42.50', image: null }, {
    AI_PROVIDER: 'anthropic', OPENROUTER_API_KEY: 'or_key', ANTHROPIC_API_KEY: 'ant_key',
  }, { fetchImpl: antFetch });
  assert(antFetch.calls[0].url === 'https://api.anthropic.com/v1/messages', 'AI_PROVIDER=anthropic must route to the Anthropic direct adapter');
  assert(antFetch.calls[0].init.headers['x-api-key'] === 'ant_key', 'anthropic routing must use ANTHROPIC_API_KEY');
  assert(result.vendor === 'Home Depot', 'parseExpense must return the normalized result regardless of provider');

  // Unrecognized AI_PROVIDER value falls back to OpenRouter (spec: "Default the env var to openrouter for now")
  const junkFetch = fakeFetch({ choices: [{ message: { content: parsedJson } }] });
  await parseExpense({ text: 'x', image: null }, {
    AI_PROVIDER: 'not_a_real_provider', OPENROUTER_API_KEY: 'or_key', ANTHROPIC_API_KEY: 'ant_key',
  }, { fetchImpl: junkFetch });
  assert(junkFetch.calls[0].url === 'https://openrouter.ai/api/v1/chat/completions', 'an unrecognized AI_PROVIDER value must fall back to OpenRouter, not throw');

  // generateSmsCopy routes the same way
  const smsFetch = fakeFetch({ content: [{ type: 'text', text: 'Saved under Materials for 123 Main St.' }] });
  const sms = await generateSmsCopy('confirmation', { amount: '42.50', category: 'Materials', house: '123 Main St' }, {
    AI_PROVIDER: 'anthropic', OPENROUTER_API_KEY: 'or_key', ANTHROPIC_API_KEY: 'ant_key',
  }, { fetchImpl: smsFetch });
  assert(sms === 'Saved under Materials for 123 Main St.', 'generateSmsCopy must return the adapter output');
  assert(smsFetch.calls[0].url === 'https://api.anthropic.com/v1/messages', 'generateSmsCopy must route through the same AI_PROVIDER dispatch as parseExpense');

  console.log('PASS: providers/index.test.js');
}

await main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/providers/index.test.js`
Expected: fails with a module-not-found error for `../../src/providers/index.js`.

- [ ] **Step 3: Write the selector**

```js
// expense-intake/src/providers/index.js
import { openRouterParseExpense, openRouterGenerateSmsCopy } from './openrouter.js';
import { anthropicParseExpense, anthropicGenerateSmsCopy } from './anthropic.js';

export async function parseExpense(input, env, deps = {}) {
  const { text, image } = input;
  const fetchImpl = deps.fetchImpl;
  if (env.AI_PROVIDER === 'anthropic') {
    return anthropicParseExpense({ apiKey: env.ANTHROPIC_API_KEY, text, image, fetchImpl });
  }
  return openRouterParseExpense({ apiKey: env.OPENROUTER_API_KEY, text, image, fetchImpl });
}

export async function generateSmsCopy(type, vars, env, deps = {}) {
  const fetchImpl = deps.fetchImpl;
  if (env.AI_PROVIDER === 'anthropic') {
    return anthropicGenerateSmsCopy({ apiKey: env.ANTHROPIC_API_KEY, type, vars, fetchImpl });
  }
  return openRouterGenerateSmsCopy({ apiKey: env.OPENROUTER_API_KEY, type, vars, fetchImpl });
}
```

- [ ] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './providers/index.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: all six test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [ ] **Step 6: Update the README's Status section and document the two new secrets**

```markdown
// expense-intake/README.md — replace the existing "## Status" section, append a new section after "## D1 setup"

## Status

Build Order steps 1-2: repo scaffolding, `wrangler.toml`, the D1 schema
migration, and the provider abstraction (`src/providers/`) with both the
OpenRouter and Anthropic adapters, unit-tested standalone. No routes are
wired up yet — every HTTP request still 404s; nothing calls the provider
abstraction for real yet (that starts at Build Order step 4).

## AI provider secrets (one-time, per environment)

The provider abstraction reads `AI_PROVIDER` (`openrouter` | `anthropic`,
defaults to `openrouter`) from `wrangler.toml`'s `[vars]`, and the matching
API key from a Worker secret:

\`\`\`bash
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
\`\`\`

Set both even in development — flipping `AI_PROVIDER` to `anthropic` in
`wrangler.toml` before a production deploy shouldn't also require a secrets
round-trip.
```

- [ ] **Step 7: Stage the change (do not commit yet — held for review)**

```bash
git add expense-intake/src/providers/index.js expense-intake/test/providers/index.test.js expense-intake/test/run-all.js expense-intake/README.md
```

---

## Self-Review — Step 2

**Spec coverage for Step 2:** "Build this first" provider abstraction → Tasks 3-6. Interface `parseExpense(input) -> {...}` / `generateSmsCopy(type, vars) -> string` → Task 6's `src/providers/index.js`, the only module other code imports. "Two swappable adapters... OpenRouter... model string `anthropic/claude-sonnet-4.5`" → Task 4, model string asserted verbatim in the test. "Anthropic direct adapter — native Messages API against api.anthropic.com" → Task 5, endpoint and `x-api-key`/`anthropic-version` headers asserted in the test. "Selection is driven by an env var AI_PROVIDER... Default... to openrouter" → Task 6, covered by the unset-env-var and unrecognized-value test cases both falling back to OpenRouter. "Both adapters must handle vision input... and return the same normalized shape" → both Task 4 and Task 5 test an image-input case, and both funnel through `normalizeParseExpenseResult` in Task 3's shared module so the output shape is identical regardless of adapter. SMS copy few-shot tone anchors from the spec's SMS COPY section → `SMS_COPY_ANCHORS` in Task 3, verified to hold the exact counts (3/2/2/1) from the spec.

**Placeholder scan:** No TBD/TODO markers. The two secrets (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`) are documented as `wrangler secret put` steps rather than hardcoded, per the spec's SECRETS section and the existing `worker/README.md` pattern — not a placeholder, since the commands are the actual completion mechanism (need the project owner's Cloudflare/API-key access to run).

**Type consistency:** `input` shape `{ text, image }` and `image` shape `{ base64, mediaType }` are used identically across Task 4's `openRouterParseExpense`, Task 5's `anthropicParseExpense`, and Task 6's `parseExpense` selector. The five-key parsed-result shape (`vendor`, `amount`, `category`, `confidence`, `raw_text`) is defined once in Task 3's `normalizeParseExpenseResult` and never redefined elsewhere — both adapters call it rather than re-validating independently, so a taxonomy or clamping change only has one place to edit. `generateSmsCopy(type, vars, env, deps)`'s parameter order matches between the Task 6 selector and both adapters' internal calls.

**Deferred to later Build Order steps (intentional, not a gap):** image preprocessing/resizing (step 3), what happens when `normalizeParseExpenseResult` throws — i.e. routing a parse failure to `pending_review` (step 4), the 10-minute correction window and house-selection KV state (step 5), and wiring `parseExpense`/`generateSmsCopy` into the actual Twilio message flow (step 4). Task 6's Design decisions note above explains why each is out of scope here.
