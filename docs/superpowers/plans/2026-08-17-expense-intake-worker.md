# Expense Intake Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.
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

- [x] **Step 1: Write the failing test**

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

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/providers/shared.test.js`
Expected: fails with a module-not-found error for `../../src/providers/shared.js` (it doesn't exist yet).

- [x] **Step 3: Write the shared module**

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

- [x] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 5: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: `PASS: schema.test.js`, `PASS: providers/shared.test.js`, `PASS: index.test.js`, `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change (do not commit yet — held for review)**

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

- [x] **Step 1: Write the failing test**

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

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/providers/openrouter.test.js`
Expected: fails with a module-not-found error for `../../src/providers/openrouter.js`.

- [x] **Step 3: Write the adapter**

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

- [x] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 5: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: all four test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change (do not commit yet — held for review)**

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

- [x] **Step 1: Write the failing test**

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

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/providers/anthropic.test.js`
Expected: fails with a module-not-found error for `../../src/providers/anthropic.js`.

- [x] **Step 3: Write the adapter**

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

- [x] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 5: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: all five test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change (do not commit yet — held for review)**

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

- [x] **Step 1: Write the failing test**

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

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/providers/index.test.js`
Expected: fails with a module-not-found error for `../../src/providers/index.js`.

- [x] **Step 3: Write the selector**

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

- [x] **Step 4: Wire the new test into the runner**

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

- [x] **Step 5: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: all six test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Update the README's Status section and document the two new secrets**

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

- [x] **Step 7: Stage the change (do not commit yet — held for review)**

```bash
git add expense-intake/src/providers/index.js expense-intake/test/providers/index.test.js expense-intake/test/run-all.js expense-intake/README.md
```

---

## Self-Review — Step 2

**Spec coverage for Step 2:** "Build this first" provider abstraction → Tasks 3-6. Interface `parseExpense(input) -> {...}` / `generateSmsCopy(type, vars) -> string` → Task 6's `src/providers/index.js`, the only module other code imports. "Two swappable adapters... OpenRouter... model string `anthropic/claude-sonnet-4.5`" → Task 4, model string asserted verbatim in the test. "Anthropic direct adapter — native Messages API against api.anthropic.com" → Task 5, endpoint and `x-api-key`/`anthropic-version` headers asserted in the test. "Selection is driven by an env var AI_PROVIDER... Default... to openrouter" → Task 6, covered by the unset-env-var and unrecognized-value test cases both falling back to OpenRouter. "Both adapters must handle vision input... and return the same normalized shape" → both Task 4 and Task 5 test an image-input case, and both funnel through `normalizeParseExpenseResult` in Task 3's shared module so the output shape is identical regardless of adapter. SMS copy few-shot tone anchors from the spec's SMS COPY section → `SMS_COPY_ANCHORS` in Task 3, verified to hold the exact counts (3/2/2/1) from the spec.

**Placeholder scan:** No TBD/TODO markers. The two secrets (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`) are documented as `wrangler secret put` steps rather than hardcoded, per the spec's SECRETS section and the existing `worker/README.md` pattern — not a placeholder, since the commands are the actual completion mechanism (need the project owner's Cloudflare/API-key access to run).

**Type consistency:** `input` shape `{ text, image }` and `image` shape `{ base64, mediaType }` are used identically across Task 4's `openRouterParseExpense`, Task 5's `anthropicParseExpense`, and Task 6's `parseExpense` selector. The five-key parsed-result shape (`vendor`, `amount`, `category`, `confidence`, `raw_text`) is defined once in Task 3's `normalizeParseExpenseResult` and never redefined elsewhere — both adapters call it rather than re-validating independently, so a taxonomy or clamping change only has one place to edit. `generateSmsCopy(type, vars, env, deps)`'s parameter order matches between the Task 6 selector and both adapters' internal calls.

**Deferred to later Build Order steps (intentional, not a gap):** image preprocessing/resizing (step 3), what happens when `normalizeParseExpenseResult` throws — i.e. routing a parse failure to `pending_review` (step 4), the 10-minute correction window and house-selection KV state (step 5), and wiring `parseExpense`/`generateSmsCopy` into the actual Twilio message flow (step 4). Task 6's Design decisions note above explains why each is out of scope here.

---

## Step 3: Twilio inbound webhook → R2 photo storage

**Interface (from spec, MESSAGE FLOW steps 1-2):** client texts a photo or plain text to their Twilio number → Worker receives the webhook → if a photo is attached, resize/compress it and store it in R2 immediately (before any parsing, since Twilio media URLs expire fast) → respond to Twilio. Parsing, categorization, Sheets writes, and confirmation SMS content are Build Order step 4 — out of scope here.

**Design decisions locked in for this step (researched against current Cloudflare/Twilio docs, not guessed):**

- **Image resize/recompress uses the Cloudflare Images Workers Binding** (`env.IMAGES.input(stream).transform({...}).output({...})`), per the project owner's explicit choice over a bundled WASM library. This requires enabling the Cloudflare Images product on the account (free tier covers 5,000 transformations/month — no card required beyond what's already needed for the other Cloudflare products this project uses) and adding an `[images]` binding to `wrangler.toml`. **There is no local emulation for this binding** — `wrangler dev` needs the `--remote` flag to exercise it for real. The plain-Node test suite can only verify the *wrapper* logic around the binding (via a fake `env.IMAGES`-shaped object, same pattern as `fetchImpl` injection elsewhere in this codebase) — the actual Cloudflare-side resize/encode behavior can only be confirmed by the project owner running `wrangler dev --remote` (or a real deploy) once Images is enabled and a database/bucket exist, which is outside what an agent can do from this session. Cap on longest side (1568px, per spec) is implemented as `width: 1568, height: 1568, fit: 'scale-down'` — a bounding-box constraint that shrinks to fit within 1568×1568 while preserving aspect ratio and never upscaling (confirmed against Cloudflare's Images docs: `scale-down` "never enlarges"; setting both dimensions makes it a box constraint rather than a single-axis resize, which matters because a *single*-axis constraint would only cap width or height, not "whichever side is longest").
- **Twilio signature verification** (`X-Twilio-Signature` header) follows Twilio's documented algorithm exactly: HMAC-SHA1 over `<full webhook URL><sorted POST param keys, each key+value concatenated directly with no delimiters>`, keyed by the Auth Token, base64-encoded, compared with a timing-safe comparison — same structural pattern as `worker/src/webhook.js`'s Stripe signature verification (HMAC + timing-safe compare), adapted to Twilio's specific string-to-sign format (confirmed against Twilio's webhook security docs, distinct from Stripe's `t=...,v1=...` format). An invalid or missing signature returns 403 and nothing is fetched or stored — this is the first thing checked, before any Twilio media URL is touched.
- **R2 key scheme:** `receipts/<url-encoded Twilio "To" number>/<timestamp>-<uuid>.jpg`. The "To" number is used (not a `client_id`) because resolving `To` → `client_id` requires a D1 query, and D1/client lookups are out of scope for this step (Build Order step 4 owns parsing and the client/house resolution that create real `expenses`/`pending_review` rows referencing this key). `clients.twilio_number` is UNIQUE per the Step 1 schema, so the "To" number is already a stable per-client partition even before any D1 lookup happens.
- **Only the first attached photo is processed** (`MediaUrl0`) if a message has multiple attachments — the spec's MESSAGE FLOW and DATA MODEL both model one photo per expense; multi-photo messages aren't addressed anywhere in the spec, so this is a reasonable scope boundary rather than a gap. Text-only messages (no media) are accepted and get a 200/empty-TwiML response with nothing stored — that message's actual parsing happens in step 4.
- **On a photo-storage failure** (Twilio media fetch fails, or the Images/R2 calls throw), the webhook returns 500 rather than swallowing the error and returning 200. Twilio retries webhook delivery on a non-2xx response — since the spec calls out "if this step fails, the photo is lost" as the reason storage happens before parsing, surfacing the failure (so Twilio retries) is more consistent with that stated goal than silently acknowledging receipt of a photo that was never saved.
- **Twilio media authentication**: Twilio requires HTTP Basic Auth (`TWILIO_ACCOUNT_SID:TWILIO_AUTH_TOKEN`) to fetch a `MediaUrl` — both secrets are already in the spec's SECRETS list from the original brief, just unused until now.
- Follows the same architectural split already established in `worker/`: pure `src/handlers.js` functions taking explicit dependencies (testable with `fetchImpl` injection and fake bindings, no real network/Cloudflare product needed), with `src/index.js` as the thin router. Two new fake test doubles (`test/fake-images.js`, `test/fake-r2.js`) mirror the existing `worker/test/fake-kv.js` pattern.

### Task 7: Twilio webhook signature verification and body parsing

**Files:**
- Create: `expense-intake/src/twilio.js`
- Create: `expense-intake/test/twilio.test.js`
- Modify: `expense-intake/test/run-all.js`

- [x] **Step 1: Write the failing test**

```js
// expense-intake/test/twilio.test.js
import crypto from 'node:crypto';
import { parseFormBody, verifyTwilioSignature, extractWebhookFields } from '../src/twilio.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function computeExpectedSignature(url, params, authToken) {
  const sortedKeys = Object.keys(params).sort();
  let stringToSign = url;
  for (const key of sortedKeys) {
    stringToSign += key + params[key];
  }
  return crypto.createHmac('sha1', authToken).update(stringToSign).digest('base64');
}

async function main() {
  // parseFormBody
  const params = parseFormBody('From=%2B15551234567&To=%2B15559876543&Body=Home+Depot+%2442.50&NumMedia=1&MediaUrl0=https%3A%2F%2Fapi.twilio.com%2Fmedia%2FME123');
  assert(params.From === '+15551234567', 'parseFormBody must URL-decode field values');
  assert(params.Body === 'Home Depot $42.50', 'parseFormBody must decode + as space');
  assert(params.NumMedia === '1', 'parseFormBody must expose NumMedia as a string field');

  // verifyTwilioSignature: valid signature
  const url = 'https://expense-intake.example.com/sms';
  const authToken = 'test_auth_token';
  const goodParams = { From: '+15551234567', To: '+15559876543', Body: 'Home Depot $42.50' };
  const validSig = computeExpectedSignature(url, goodParams, authToken);
  const validResult = await verifyTwilioSignature({ url, params: goodParams, signature: validSig, authToken });
  assert(validResult === true, 'a correctly computed signature must verify as valid');

  // verifyTwilioSignature: tampered signature
  const tamperedResult = await verifyTwilioSignature({ url, params: goodParams, signature: 'not-the-real-signature==', authToken });
  assert(tamperedResult === false, 'a tampered/incorrect signature must not verify');

  // verifyTwilioSignature: tampered params (same signature, different body)
  const tamperedParams = { ...goodParams, Body: 'Home Depot $999.99' };
  const tamperedParamsResult = await verifyTwilioSignature({ url, params: tamperedParams, signature: validSig, authToken });
  assert(tamperedParamsResult === false, 'a signature computed for different params must not verify against altered params');

  // verifyTwilioSignature: missing signature or authToken
  assert((await verifyTwilioSignature({ url, params: goodParams, signature: '', authToken })) === false, 'an empty signature must not verify');
  assert((await verifyTwilioSignature({ url, params: goodParams, signature: validSig, authToken: '' })) === false, 'a missing authToken must not verify');

  // extractWebhookFields: text-only message
  const textOnly = extractWebhookFields({ From: '+15551234567', To: '+15559876543', Body: 'Home Depot $42.50', NumMedia: '0' });
  assert(textOnly.from === '+15551234567' && textOnly.to === '+15559876543' && textOnly.body === 'Home Depot $42.50', 'extractWebhookFields must extract From/To/Body');
  assert(textOnly.media.length === 0, 'a text-only message must have an empty media array');

  // extractWebhookFields: message with one photo
  const withPhoto = extractWebhookFields({
    From: '+15551234567', To: '+15559876543', Body: '', NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/media/ME123', MediaContentType0: 'image/jpeg',
  });
  assert(withPhoto.media.length === 1, 'a message with NumMedia=1 must produce one media entry');
  assert(withPhoto.media[0].url === 'https://api.twilio.com/media/ME123' && withPhoto.media[0].contentType === 'image/jpeg', 'the media entry must carry the URL and content type');

  // extractWebhookFields: NumMedia present but the indexed field is missing (defensive)
  const malformed = extractWebhookFields({ From: '+1', To: '+2', Body: '', NumMedia: '2', MediaUrl0: 'https://api.twilio.com/media/ME1', MediaContentType0: 'image/jpeg' });
  assert(malformed.media.length === 1, 'a missing MediaUrl at a given index must be skipped rather than producing a broken entry');

  console.log('PASS: twilio.test.js');
}

await main();
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/twilio.test.js`
Expected: fails with a module-not-found error for `../src/twilio.js`.

- [x] **Step 3: Write the module**

```js
// expense-intake/src/twilio.js

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function parseFormBody(text) {
  return Object.fromEntries(new URLSearchParams(text));
}

// Twilio's request-signing algorithm: HMAC-SHA1(authToken, url + sortedKey1 + value1 + sortedKey2 + value2 + ...),
// base64-encoded. https://www.twilio.com/docs/usage/webhooks/webhooks-security
export async function verifyTwilioSignature({ url, params, signature, authToken }) {
  if (!signature || !authToken) return false;

  const sortedKeys = Object.keys(params).sort();
  let stringToSign = url;
  for (const key of sortedKeys) {
    stringToSign += key + params[key];
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(stringToSign));
  const expected = bufferToBase64(signed);

  return timingSafeEqual(expected, signature);
}

export function extractWebhookFields(params) {
  const numMedia = Number.parseInt(params.NumMedia || '0', 10) || 0;
  const media = [];
  for (let i = 0; i < numMedia; i++) {
    const mediaUrl = params[`MediaUrl${i}`];
    if (mediaUrl) {
      media.push({ url: mediaUrl, contentType: params[`MediaContentType${i}`] || 'application/octet-stream' });
    }
  }
  return { from: params.From || '', to: params.To || '', body: params.Body || '', media };
}
```

- [x] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './providers/index.test.js';
import './twilio.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 5: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: all seven test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/twilio.js expense-intake/test/twilio.test.js expense-intake/test/run-all.js
```

---

### Task 8: Receipt photo storage pipeline (resize/recompress via Cloudflare Images, store to R2)

**Files:**
- Create: `expense-intake/src/receipt-storage.js`
- Create: `expense-intake/test/fake-images.js`
- Create: `expense-intake/test/fake-r2.js`
- Create: `expense-intake/test/receipt-storage.test.js`
- Modify: `expense-intake/test/run-all.js`

- [x] **Step 1: Write the failing test**

```js
// expense-intake/test/fake-images.js
// Mimics the shape of the real Cloudflare Images Workers binding (env.IMAGES) closely enough
// to test the calling code's wiring, without needing the real binding (which has no local
// emulation — see Step 3's Design decisions note in the plan).
export function createFakeImagesBinding(outputBytes) {
  const calls = [];
  return {
    input(source) {
      const call = { source, transformOptions: null, outputOptions: null };
      calls.push(call);
      const chain = {
        transform(options) {
          call.transformOptions = options;
          return chain;
        },
        async output(options) {
          call.outputOptions = options;
          return {
            response() {
              return { arrayBuffer: async () => outputBytes };
            },
          };
        },
      };
      return chain;
    },
    calls,
  };
}
```

```js
// expense-intake/test/fake-r2.js
export function createFakeR2Bucket() {
  const store = new Map();
  return {
    async put(key, value, options) {
      store.set(key, { value, options });
    },
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    _store: store,
  };
}
```

```js
// expense-intake/test/receipt-storage.test.js
import { generateReceiptKey, storeReceiptPhoto } from '../src/receipt-storage.js';
import { createFakeImagesBinding } from './fake-images.js';
import { createFakeR2Bucket } from './fake-r2.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function fakeFetch(ok, status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, body };
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  // generateReceiptKey format
  const key = generateReceiptKey('+15559876543');
  assert(/^receipts\/%2B15559876543\/\d+-[0-9a-f-]{36}\.jpg$/.test(key), `generateReceiptKey must produce a receipts/<encoded-number>/<timestamp>-<uuid>.jpg key, got: ${key}`);

  // storeReceiptPhoto: happy path — fetches with Basic Auth, transforms via Images binding, stores to R2
  const mediaBody = { fake: 'stream' };
  const fetchImpl = fakeFetch(true, 200, mediaBody);
  const jpegBytes = new ArrayBuffer(8);
  const imagesBinding = createFakeImagesBinding(jpegBytes);
  const bucket = createFakeR2Bucket();

  const resultKey = await storeReceiptPhoto({
    mediaUrl: 'https://api.twilio.com/media/ME123',
    accountSid: 'AC_test',
    authToken: 'auth_test',
    imagesBinding,
    bucket,
    key: 'receipts/test/123.jpg',
    fetchImpl,
  });

  assert(resultKey === 'receipts/test/123.jpg', 'storeReceiptPhoto must return the key it was given');
  assert(fetchImpl.calls[0].url === 'https://api.twilio.com/media/ME123', 'must fetch the exact Twilio media URL');
  const expectedAuth = `Basic ${Buffer.from('AC_test:auth_test').toString('base64')}`;
  assert(fetchImpl.calls[0].init.headers.Authorization === expectedAuth, 'must send Twilio account SID/auth token as Basic Auth');
  assert(imagesBinding.calls[0].source === mediaBody, 'must pass the fetched media response body into the Images binding');
  assert(imagesBinding.calls[0].transformOptions.width === 1568 && imagesBinding.calls[0].transformOptions.height === 1568, 'must cap both dimensions at 1568px');
  assert(imagesBinding.calls[0].transformOptions.fit === 'scale-down', 'must use scale-down fit so smaller images are never upscaled');
  assert(imagesBinding.calls[0].outputOptions.format === 'image/jpeg' && imagesBinding.calls[0].outputOptions.quality === 85, 'must re-encode as JPEG at quality 85');
  const stored = bucket._store.get('receipts/test/123.jpg');
  assert(stored.value === jpegBytes, 'must store the transformed JPEG bytes in R2 under the given key');
  assert(stored.options.httpMetadata.contentType === 'image/jpeg', 'must set the R2 object content type to image/jpeg');

  // storeReceiptPhoto: Twilio media fetch failure
  const failFetch = fakeFetch(false, 404, null);
  let threw = false;
  try {
    await storeReceiptPhoto({
      mediaUrl: 'https://api.twilio.com/media/ME_missing',
      accountSid: 'AC_test',
      authToken: 'auth_test',
      imagesBinding: createFakeImagesBinding(jpegBytes),
      bucket: createFakeR2Bucket(),
      key: 'receipts/test/456.jpg',
      fetchImpl: failFetch,
    });
  } catch (err) {
    threw = true;
    assert(/404/.test(err.message), 'the error must surface the failed status code');
  }
  assert(threw, 'a failed Twilio media fetch must throw rather than silently store nothing');

  console.log('PASS: receipt-storage.test.js');
}

await main();
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/receipt-storage.test.js`
Expected: fails with a module-not-found error for `../src/receipt-storage.js`.

- [x] **Step 3: Write the module**

```js
// expense-intake/src/receipt-storage.js
const MAX_DIMENSION = 1568;
const JPEG_QUALITY = 85;

export function generateReceiptKey(toNumber) {
  return `receipts/${encodeURIComponent(toNumber || 'unknown')}/${Date.now()}-${crypto.randomUUID()}.jpg`;
}

export async function storeReceiptPhoto({ mediaUrl, accountSid, authToken, imagesBinding, bucket, key, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const basicAuth = btoa(`${accountSid}:${authToken}`);
  const mediaResponse = await doFetch(mediaUrl, { headers: { Authorization: `Basic ${basicAuth}` } });
  if (!mediaResponse.ok) {
    throw new Error(`Failed to fetch Twilio media: ${mediaResponse.status}`);
  }

  const transformed = await imagesBinding
    .input(mediaResponse.body)
    .transform({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'scale-down' })
    .output({ format: 'image/jpeg', quality: JPEG_QUALITY });
  const jpegBytes = await transformed.response().arrayBuffer();

  await bucket.put(key, jpegBytes, { httpMetadata: { contentType: 'image/jpeg' } });
  return key;
}
```

- [x] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './providers/index.test.js';
import './twilio.test.js';
import './receipt-storage.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 5: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: all eight test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/receipt-storage.js expense-intake/test/fake-images.js expense-intake/test/fake-r2.js expense-intake/test/receipt-storage.test.js expense-intake/test/run-all.js
```

---

### Task 9: Wire the `/sms` route (handlers.js + index.js), R2/Images bindings, and docs

**Files:**
- Create: `expense-intake/src/handlers.js`
- Create: `expense-intake/test/handlers.test.js`
- Modify: `expense-intake/src/index.js`
- Modify: `expense-intake/test/index.test.js`
- Modify: `expense-intake/test/run-all.js`
- Modify: `expense-intake/wrangler.toml`
- Modify: `expense-intake/README.md`

This follows the same split as `worker/`: `handlers.js` holds pure, exhaustively-tested request-handling logic (dependency-injected, no real I/O in tests); `index.js` stays a thin router, checked with a lighter integration-level test (real `fetch` handler, `globalThis.fetch` monkey-patched for the one case that needs a real-shaped network call — same pattern `worker/test/index.test.js` already uses for its `/checkout` and `/portal-link` tests).

- [x] **Step 1: Write the failing tests**

```js
// expense-intake/test/handlers.test.js
import crypto from 'node:crypto';
import { handleSmsWebhook } from '../src/handlers.js';
import { createFakeImagesBinding } from './fake-images.js';
import { createFakeR2Bucket } from './fake-r2.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function computeTwilioSignature(url, params, authToken) {
  const sortedKeys = Object.keys(params).sort();
  let stringToSign = url;
  for (const key of sortedKeys) {
    stringToSign += key + params[key];
  }
  return crypto.createHmac('sha1', authToken).update(stringToSign).digest('base64');
}

function fakeFetch(ok, status, body) {
  return async () => ({ ok, status, body });
}

async function main() {
  const authToken = 'test_auth_token';
  const url = 'https://expense-intake.example.com/sms';

  // invalid signature -> 403, nothing stored
  const rejectedBucket = createFakeR2Bucket();
  let result = await handleSmsWebhook({
    url, bodyText: 'From=%2B1555&To=%2B1556&Body=hi&NumMedia=0', signature: 'bad-sig',
    accountSid: 'AC_test', authToken, imagesBinding: createFakeImagesBinding(new ArrayBuffer(0)), bucket: rejectedBucket,
  });
  assert(result.status === 403, 'an invalid signature must return 403');
  assert(rejectedBucket._store.size === 0, 'nothing should be stored when the signature is invalid');

  // valid signature, text-only -> 200, TwiML, nothing stored
  const textParams = { From: '+15551234567', To: '+15559876543', Body: 'hello', NumMedia: '0' };
  const textBody = new URLSearchParams(textParams).toString();
  const textSig = computeTwilioSignature(url, textParams, authToken);
  const textBucket = createFakeR2Bucket();
  result = await handleSmsWebhook({
    url, bodyText: textBody, signature: textSig,
    accountSid: 'AC_test', authToken, imagesBinding: createFakeImagesBinding(new ArrayBuffer(0)), bucket: textBucket,
  });
  assert(result.status === 200 && result.contentType === 'text/xml' && result.body.includes('<Response>'), 'a text-only message must return 200 with TwiML');
  assert(textBucket._store.size === 0, 'a text-only message must not store anything to R2');

  // valid signature, with photo -> 200, photo stored
  const photoParams = {
    From: '+15551234567', To: '+15559876543', Body: '', NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/media/ME123', MediaContentType0: 'image/jpeg',
  };
  const photoBody = new URLSearchParams(photoParams).toString();
  const photoSig = computeTwilioSignature(url, photoParams, authToken);
  const photoBucket = createFakeR2Bucket();
  const photoFetch = fakeFetch(true, 200, { fake: 'stream' });
  result = await handleSmsWebhook({
    url, bodyText: photoBody, signature: photoSig,
    accountSid: 'AC_test', authToken, imagesBinding: createFakeImagesBinding(new ArrayBuffer(8)), bucket: photoBucket, fetchImpl: photoFetch,
  });
  assert(result.status === 200, 'a message with a photo must return 200');
  assert(photoBucket._store.size === 1, 'a message with a photo must store exactly one object');

  // valid signature, photo storage fails -> 500, so Twilio retries delivery
  const failParams = {
    From: '+15551234567', To: '+15559876543', Body: '', NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/media/ME_missing', MediaContentType0: 'image/jpeg',
  };
  const failBody = new URLSearchParams(failParams).toString();
  const failSig = computeTwilioSignature(url, failParams, authToken);
  const failFetch = fakeFetch(false, 404, null);
  result = await handleSmsWebhook({
    url, bodyText: failBody, signature: failSig,
    accountSid: 'AC_test', authToken, imagesBinding: createFakeImagesBinding(new ArrayBuffer(8)), bucket: createFakeR2Bucket(), fetchImpl: failFetch,
  });
  assert(result.status === 500, 'a failed photo storage must return 500 so Twilio retries delivery');

  console.log('PASS: handlers.test.js');
}

await main();
```

```js
// expense-intake/test/index.test.js — full replacement of the existing file
import crypto from 'node:crypto';
import workerModule from '../src/index.js';
import { createFakeImagesBinding } from './fake-images.js';
import { createFakeR2Bucket } from './fake-r2.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function computeTwilioSignature(url, params, authToken) {
  const sortedKeys = Object.keys(params).sort();
  let stringToSign = url;
  for (const key of sortedKeys) {
    stringToSign += key + params[key];
  }
  return crypto.createHmac('sha1', authToken).update(stringToSign).digest('base64');
}

async function main() {
  // unrouted requests still 404
  let request = new Request('https://expense-intake.example.com/', { method: 'GET' });
  let response = await workerModule.fetch(request, {});
  assert(response.status === 404, 'unrouted requests should 404');

  const authToken = 'test_auth_token';
  const smsUrl = 'https://expense-intake.example.com/sms';
  function baseEnv(imagesBinding, bucket) {
    return {
      TWILIO_ACCOUNT_SID: 'AC_test',
      TWILIO_AUTH_TOKEN: authToken,
      IMAGES: imagesBinding,
      RECEIPTS_BUCKET: bucket,
    };
  }

  // POST /sms with an invalid signature is rejected, through the real routing layer
  const rejectedBucket = createFakeR2Bucket();
  request = new Request(smsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'not-a-real-signature' },
    body: 'From=%2B15551234567&To=%2B15559876543&Body=hello&NumMedia=0',
  });
  response = await workerModule.fetch(request, baseEnv(createFakeImagesBinding(new ArrayBuffer(0)), rejectedBucket));
  assert(response.status === 403, 'an invalid Twilio signature must be rejected with 403 through the real route');

  // POST /sms, text-only message with a valid signature, through the real routing layer
  const textParams = { From: '+15551234567', To: '+15559876543', Body: 'hello', NumMedia: '0' };
  const textSig = computeTwilioSignature(smsUrl, textParams, authToken);
  const textBucket = createFakeR2Bucket();
  request = new Request(smsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': textSig },
    body: new URLSearchParams(textParams).toString(),
  });
  response = await workerModule.fetch(request, baseEnv(createFakeImagesBinding(new ArrayBuffer(0)), textBucket));
  assert(response.status === 200, 'a validly signed text-only message should return 200 through the real route');
  assert(response.headers.get('Content-Type') === 'text/xml', 'the response to Twilio must be TwiML (text/xml)');
  const textBody = await response.text();
  assert(textBody.includes('<Response>'), 'the response body must be valid (if minimal) TwiML');
  assert(textBucket._store.size === 0, 'a text-only message must not store anything to R2');

  // POST /sms, message with a photo and a valid signature — the one case that needs a
  // network-shaped fetch (Twilio media fetch), so globalThis.fetch is monkey-patched,
  // same pattern worker/test/index.test.js already uses for its /checkout and /portal-link tests.
  const photoParams = {
    From: '+15551234567', To: '+15559876543', Body: '', NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/media/ME123', MediaContentType0: 'image/jpeg',
  };
  const photoSig = computeTwilioSignature(smsUrl, photoParams, authToken);
  const photoBucket = createFakeR2Bucket();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, body: { fake: 'twilio-media-stream' } });
  try {
    request = new Request(smsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': photoSig },
      body: new URLSearchParams(photoParams).toString(),
    });
    response = await workerModule.fetch(request, baseEnv(createFakeImagesBinding(new ArrayBuffer(8)), photoBucket));
    assert(response.status === 200, 'a validly signed photo message should return 200 through the real route');
    assert(photoBucket._store.size === 1, 'a message with a photo must store exactly one object to R2 through the real route');
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('PASS: index.test.js');
}

await main();
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node expense-intake/test/handlers.test.js`
Expected: fails with a module-not-found error for `../src/handlers.js`.

Run: `node expense-intake/test/index.test.js`
Expected: fails — the new assertions expect routes that don't exist yet (POST /sms currently 404s).

- [x] **Step 3: Write `src/handlers.js`**

```js
// expense-intake/src/handlers.js
import { parseFormBody, verifyTwilioSignature, extractWebhookFields } from './twilio.js';
import { generateReceiptKey, storeReceiptPhoto } from './receipt-storage.js';

export async function handleSmsWebhook({ url, bodyText, signature, accountSid, authToken, imagesBinding, bucket, fetchImpl }) {
  const params = parseFormBody(bodyText);
  const valid = await verifyTwilioSignature({ url, params, signature, authToken });
  if (!valid) {
    return { status: 403, contentType: 'text/plain', body: 'Forbidden' };
  }

  const fields = extractWebhookFields(params);
  if (fields.media.length > 0) {
    const key = generateReceiptKey(fields.to);
    try {
      await storeReceiptPhoto({
        mediaUrl: fields.media[0].url,
        accountSid,
        authToken,
        imagesBinding,
        bucket,
        key,
        fetchImpl,
      });
    } catch (err) {
      // Twilio retries webhook delivery on a non-2xx response — surfacing this as a
      // failure (rather than swallowing it and returning 200) gives the photo another
      // chance to be stored instead of being silently lost, per the spec's stated
      // reason for storing before parsing.
      console.error('Failed to store receipt photo', { error: err.message });
      return { status: 500, contentType: 'text/plain', body: 'Failed to store photo' };
    }
  }

  return { status: 200, contentType: 'text/xml', body: '<Response></Response>' };
}
```

- [x] **Step 4: Update `src/index.js`**

```js
// expense-intake/src/index.js — full replacement
import { handleSmsWebhook } from './handlers.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/sms') {
      const bodyText = await request.text();
      const signature = request.headers.get('X-Twilio-Signature') || '';
      const result = await handleSmsWebhook({
        url: request.url,
        bodyText,
        signature,
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        imagesBinding: env.IMAGES,
        bucket: env.RECEIPTS_BUCKET,
      });
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      });
    }

    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
```

- [x] **Step 5: Wire the new tests into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './providers/index.test.js';
import './twilio.test.js';
import './receipt-storage.test.js';
import './handlers.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 6: Run tests to verify they pass**

Run: `node expense-intake/test/run-all.js`
Expected: all nine test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 7: Add the R2 and Images bindings to `wrangler.toml`**

```toml
# expense-intake/wrangler.toml — add these two blocks (keep everything already there)

[[r2_buckets]]
binding = "RECEIPTS_BUCKET"
bucket_name = "expense-intake-receipts"

[images]
binding = "IMAGES"
```

- [x] **Step 8: Update the README — new setup steps, Status section, and route**

```markdown
// expense-intake/README.md — add a "## Routes" section after the intro paragraph,
// replace "## Status", and add a new section after "## AI provider secrets"

## Routes

- `POST /sms` — Twilio inbound SMS/MMS webhook. Validates `X-Twilio-Signature`,
  stores any attached photo (resized/recompressed) to R2, and responds with
  TwiML. Parsing, categorization, and confirmation SMS content are Build
  Order step 4 — this route currently stores photos and acknowledges
  text-only messages without doing anything else with them yet.

## Status

Build Order steps 1-3: repo scaffolding, `wrangler.toml`, the D1 schema
migration, the provider abstraction (`src/providers/`, unit-tested
standalone, not yet wired into any route), and the Twilio inbound webhook
(`POST /sms`) with signature verification and R2 photo storage. No parsing,
categorization, Sheets writes, or confirmation SMS content yet — those are
Build Order step 4.

## R2 bucket and Cloudflare Images setup (one-time, per environment)

\`\`\`bash
npx wrangler r2 bucket create expense-intake-receipts
\`\`\`

Cloudflare Images must also be enabled on the account (Dashboard → Images →
Enable) before the `[images]` binding in `wrangler.toml` will work. The free
tier covers 5,000 transformations/month, which this project's expected
volume is well under. **There is no local emulation for the Images
binding** — `npx wrangler dev --remote` is required to exercise the real
resize/recompress behavior; the plain-Node test suite only verifies the
wrapper logic around it (see `test/fake-images.js`).

## Twilio secrets (one-time, per environment)

\`\`\`bash
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
\`\`\`

Once a Twilio phone number is provisioned (Build Order step 9's onboarding
CLI script), point its messaging webhook at
\`https://<this Worker's deployed URL>/sms\` — the exact URL configured in
the Twilio console must match what's used to compute
\`X-Twilio-Signature\` in \`src/twilio.js\`, or every inbound message will
be rejected with 403.
```

- [x] **Step 9: Stage the change**

```bash
git add expense-intake/src/handlers.js expense-intake/test/handlers.test.js expense-intake/src/index.js expense-intake/test/index.test.js expense-intake/test/run-all.js expense-intake/wrangler.toml expense-intake/README.md
```

---

## Self-Review — Step 3

**Spec coverage for Step 3:** MESSAGE FLOW step 1 ("Client texts photo or free text") → the `/sms` route accepts both. MESSAGE FLOW step 2 ("Resize/compress the image, then store it in R2 immediately — Twilio media URLs expire fast. If this step fails, the photo is lost, so it happens before parsing") → Task 8's `storeReceiptPhoto` (resize/recompress happens as part of the same pipeline that fetches from Twilio and writes to R2, no parsing call anywhere in this step) and Task 9's `handleSmsWebhook` (storage happens, and only completes, before any response is sent — a storage failure surfaces as 500 rather than a false-positive 200). IMAGE PREPROCESSING section ("Resize so the longest side is capped at 1568px... Re-encode as JPEG at ~85% quality... before it's written to R2") → Task 8, `width: 1568, height: 1568, fit: 'scale-down'` + `format: 'image/jpeg', quality: 85`, matching the spec's numbers exactly. SECRETS section (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`) → both now used, for signature verification (Task 7) and Basic Auth on the media fetch (Task 8).

**Not yet in scope, intentionally (Build Order step 4):** parsing (`parseExpense` isn't called anywhere in this step), client/house resolution via D1, categorization, Google Sheets writes, and real confirmation SMS content (the current `<Response></Response>` is an intentionally empty acknowledgment, not the spec's confirmation copy). The Design decisions note above explains the R2 key scheme choice (`To` number, not `client_id`) that keeps this step decoupled from D1.

**Placeholder scan:** No TBD/TODO markers. `expense-intake-receipts` as the R2 bucket name is a real, final value (not a placeholder needing replacement), matching how `worker/wrangler.toml` names its own resources directly rather than with a placeholder.

**Type consistency:** `handleSmsWebhook`'s return shape (`{status, contentType, body}`) is a new shape distinct from `worker/`'s `{status, body}` JSON-only convention — necessary because this route returns TwiML/XML and plain text, not JSON; `src/index.js`'s route handler consumes exactly this shape. `fields.media[]` entries (`{url, contentType}`) from Task 7's `extractWebhookFields` are consumed identically in Task 9's `handleSmsWebhook` (`fields.media[0].url`) and match what Task 8's `storeReceiptPhoto` expects as `mediaUrl`. The `imagesBinding`/`bucket` parameter names are identical across Task 8's `storeReceiptPhoto`, Task 9's `handleSmsWebhook`, and `src/index.js`'s `env.IMAGES`/`env.RECEIPTS_BUCKET` wiring — no renaming across the chain.

**Known limitation flagged for the project owner, not silently glossed over:** because the Images binding has no local emulation, this step's automated tests (all of which run via plain `node`, zero dependencies) cannot verify that the *real* Cloudflare-side resize/recompress actually produces a correctly-sized, correctly-compressed JPEG — only that the Worker code calls the binding with the right parameters. Confirming the real behavior requires the project owner to run `wrangler dev --remote` (or deploy) with Images enabled and a Twilio number actually pointed at `/sms`, which is described in the README but can't be executed from an agent's local session.

---

## Step 4: Parse → categorize → Sheets write → confirmation SMS (happy path)

**Interface (from spec, MESSAGE FLOW steps 3, 5-6; GOOGLE SHEETS FORMAT; SMS COPY):** after a photo is stored (or for a text-only message), call `parseExpense()`, determine the house, and either write a row to that house's Google Sheet + `expenses` table and reply with confirmation copy (high confidence, exactly one house), or write to `pending_review` and reply with the appropriate copy (low confidence, or house ambiguous). House-selection's actual KV-backed interactive prompt-and-wait and the 10-minute correction window are Build Order step 5 — out of scope here.

**Design decisions locked in for this step (researched against current Google/Twilio docs, plus two decisions confirmed with the project owner):**

- **Photo access for the Sheet's "Photo" column** (confirmed with project owner): a new public, unauthenticated `GET /receipts/:key` route streams the object straight from R2. Security relies on the R2 key being effectively unguessable (it already embeds a random UUID, from Step 3) — the same trust model as "anyone with this link" sharing. No signed/expiring URLs in this step.
- **Google Sheets auth** uses the service-account JWT-bearer OAuth flow (researched against Google's own docs, not guessed): build a JWT (header `{alg: "RS256", typ: "JWT"}`, claim set `{iss: <service account email>, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat, exp: iat+3600}`), sign it with the service account's PKCS8 private key via `crypto.subtle.sign('RSASSA-PKCS1-v1_5', ...)`, POST it to `https://oauth2.googleapis.com/token` as a `urn:ietf:params:oauth:grant-type:jwt-bearer` assertion, and use the returned `access_token` as a Bearer token against the Sheets API. This is the same "sign something, POST it, use Web Crypto" shape as Twilio's HMAC verification and OpenRouter/Anthropic's Bearer auth, just with RS256 instead of HMAC. `GOOGLE_SERVICE_ACCOUNT_JSON` (already in the spec's SECRETS list, unused until now) holds the full service-account JSON key file as a single secret value.
- **Sheets write** uses `POST https://sheets.googleapis.com/v4/spreadsheets/{id}/values/Sheet1!A:I:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`. `USER_ENTERED` (not `RAW`) is required, not a style choice — the spec's "Tax Rollup" tab auto-sums `Amount` by `Category`, which only works if Sheets recognizes the Amount cell as a real number, not literal text.
- **Confirmation SMS is a synchronous TwiML `<Message>` in the webhook response**, not a separate outbound REST call — Twilio natively supports replying to an inbound message this way, and it's simpler and faster than a second authenticated round-trip. This means **no outbound-send module is needed in this step at all** — that only becomes necessary for the monthly nudge (Build Order step 7, a cron job with no inbound webhook to piggyback a TwiML reply on), so building it now would be speculative. `src/twilio.js` gets no outbound-send function in this step.
- **Confidence threshold** is a named constant, `CONFIDENCE_THRESHOLD = 0.7`, in `src/expense-flow.js`. The spec doesn't pin an exact number ("Low confidence → write to pending_review only" without a threshold) — this is a tunable engineering parameter, not a business decision with infra/security stakes, so a sensible default is used and called out clearly as adjustable once the project owner sees real-world parse results.
- **House ambiguity, before Build Order step 5's interactive flow exists:** a client with zero or more than one house is treated like a low-confidence case for *this* step only — the expense is written to `pending_review` with `house_id = NULL` (the schema already supports this, from Step 1), and the reply uses the spec's `house_selection` SMS copy (already defined in `src/providers/shared.js` from Step 2). If the client replies with a house name before step 5 ships the actual KV-backed matching logic, that reply is just processed as a new, independent inbound message — not lost, just not yet intelligently matched to the pending item. This is a temporary, self-correcting gap step 5 closes, not data loss.
- **A resolved house with no `google_sheet_id` set** (a client/house onboarded via manual SQL — the "v1 manual" onboarding process, since Build Order step 9's CLI script doesn't exist yet — before its Sheet was created) throws an explicit error rather than silently falling back to `pending_review`. A missing Sheet is an onboarding/configuration gap, not a parsing-confidence issue, and silently swallowing it would make manual testing confusing (never knowing if the code or the setup is broken). The error is loud (visible in `wrangler tail`) and the webhook returns 500, matching the existing "let Twilio retry, don't return a false 200" pattern from Step 3.
- **Unknown Twilio "To" number or unauthorized sender phone number** both produce a silent, empty TwiML acknowledgment (200, no `<Message>`) — there's no client record to pull tone/copy from for an unrecognized number, and replying to a number that isn't on `authorized_senders` would leak whether that's a valid client number to a stranger.
- **A genuinely empty inbound message** (no body text, no photo) short-circuits before any D1 lookups — there's nothing to process.
- Follows the established architecture: small pure modules taking explicit dependencies, `fetchImpl` injection throughout, a new `test/fake-d1.js` test double (mirroring `test/fake-kv.js`/`test/fake-r2.js`) for the D1 binding.
- **A `null` amount always routes to `pending_review`, regardless of confidence** (added during Task 15's code review): `normalizeParseExpenseResult` allows `amount: null` independently of `confidence` — a model can be fully confident about vendor/category while the total is illegible. Auto-filing that as `$0.00` would be indistinguishable from a genuine zero-dollar expense and give the client no signal to use the correction window. The high-confidence auto-file condition is `parsed.confidence >= CONFIDENCE_THRESHOLD && parsed.amount != null`.
- **Idempotency guard against Twilio webhook retries (Task 16), confirmed with the project owner rather than deferred.** If `appendExpenseRow`/`insertExpense`/`insertPendingReview` succeed but the response never makes it back to Twilio in time (slow reply, transient network issue), Twilio retries the whole POST, and without a guard `processExpenseMessage` would run again from scratch — writing a second Sheet row and a second `expenses`/`pending_review` row for one physical receipt. Fixing this needed a dedupe key (Twilio's `MessageSid`, added to `extractWebhookFields` in Task 16 — extending Step 3's already-committed `src/twilio.js`) and somewhere to record "already processed": a new `CONVERSATION_STATE` KV namespace, introduced now rather than waiting for Build Order step 5 (which will reuse the same namespace for house-selection/correction-window state, not add a second one). This is a best-effort, mark-after-success guard, not an airtight distributed lock — genuine concurrent double-delivery (two invocations processing the same still-in-flight message at once) remains a real, accepted residual gap that would need atomic compare-and-swap (Durable Objects, not proportionate here yet) to close fully.
- **`safeGenerateSmsCopy` fallback (Task 15, added during Step 4's whole-step review — this was a Critical finding, not a nice-to-have).** The mark-after-success design above only protects against retries IF `processExpenseMessage` actually reaches success. Without this fix, an ordinary `generateSmsCopy` failure (rate limit, timeout — routine for an external API call) occurring *after* `appendExpenseRow`/`insertExpense` had already committed would propagate uncaught, turn the response into a 500, and — since nothing gets cached on a 500 — deterministically cause Twilio's retry to reprocess and duplicate the write. This wasn't a rare concurrency edge case; it was a guaranteed duplication on any sequential copy-generation failure after a successful write, which defeated much of the point of Task 16. `safeGenerateSmsCopy` wraps all three `generateSmsCopy` call sites in `expense-flow.js`, falling back to static (non-AI-generated) copy — with the real values substituted, not the raw `SMS_COPY_ANCHORS` template strings — so the pipeline always reaches a cacheable success once the underlying write has committed, regardless of whether the "nice" AI-generated wording succeeds.

### Task 10: D1 query helpers

**Files:**
- Create: `expense-intake/src/db.js`
- Create: `expense-intake/test/fake-d1.js`
- Create: `expense-intake/test/db.test.js`
- Modify: `expense-intake/test/run-all.js`

- [x] **Step 1: Write the failing test**

```js
// expense-intake/test/fake-d1.js
// Mimics the shape of the real D1 binding (env.DB) closely enough to test query-layer
// wiring: prepare(sql).bind(...params).first()/.all()/.run(). Keyed by exact SQL string,
// since src/db.js's queries are fixed, known strings — same call-recording spirit as
// fakeFetch elsewhere in this codebase.
export function createFakeD1(responses = {}) {
  const calls = [];

  function makeStatement(sql) {
    let boundParams = [];
    const statement = {
      bind(...params) {
        boundParams = params;
        return statement;
      },
      async first() {
        calls.push({ sql, params: boundParams, method: 'first' });
        const handler = responses[sql];
        const value = typeof handler === 'function' ? handler(boundParams) : handler;
        return value === undefined ? null : value;
      },
      async all() {
        calls.push({ sql, params: boundParams, method: 'all' });
        const handler = responses[sql];
        const value = typeof handler === 'function' ? handler(boundParams) : handler;
        return { results: value || [] };
      },
      async run() {
        calls.push({ sql, params: boundParams, method: 'run' });
        const handler = responses[sql];
        const value = typeof handler === 'function' ? handler(boundParams) : handler;
        return value || { success: true, meta: { last_row_id: 1, changes: 1 } };
      },
    };
    return statement;
  }

  return {
    prepare(sql) {
      return makeStatement(sql);
    },
    calls,
  };
}
```

```js
// expense-intake/test/db.test.js
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

  // insertExpense: notes defaults to empty string when omitted
  const db7 = createFakeD1();
  await insertExpense(db7, {
    houseId: 10, date: '2026-08-17', vendor: null, amount: null, category: 'Other',
    confidence: 0.2, photoR2Key: null, rawText: '', loggedByPhone: '+15551234567',
  });
  assert(db7.calls[0].params[9] === '', 'insertExpense must default a missing notes value to an empty string, not undefined');

  // insertPendingReview
  const db8 = createFakeD1();
  await insertPendingReview(db8, {
    clientId: 1, houseId: null, amountGuess: null, categoryGuess: null,
    photoR2Key: 'receipts/x/2.jpg', rawText: 'unclear', confidence: 0, expiresAt: '2026-10-16T00:00:00.000Z',
  });
  const pendingCall = db8.calls[0];
  assert(pendingCall.sql.includes('INSERT INTO pending_review'), 'insertPendingReview must INSERT into the pending_review table');
  assert(pendingCall.params[0] === 1 && pendingCall.params[1] === null, 'must bind client_id and a null house_id when the house is ambiguous');

  console.log('PASS: db.test.js');
}

await main();
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/db.test.js`
Expected: fails with a module-not-found error for `../src/db.js`.

- [x] **Step 3: Write the module**

```js
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
```

- [x] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './providers/index.test.js';
import './twilio.test.js';
import './receipt-storage.test.js';
import './db.test.js';
import './handlers.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 5: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: all ten test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/db.js expense-intake/test/fake-d1.js expense-intake/test/db.test.js expense-intake/test/run-all.js
```

---

### Task 11: Google service-account authentication

**Files:**
- Create: `expense-intake/src/google-auth.js`
- Create: `expense-intake/test/google-auth.test.js`
- Modify: `expense-intake/test/run-all.js`

The test generates a real RSA keypair with Node's `crypto.generateKeyPairSync` and verifies the module's JWT signature against the real public key — this catches a broken signing implementation (wrong algorithm, wrong encoding, wrong signing input) in a way a hand-typed fake signature never could.

- [x] **Step 1: Write the failing test**

```js
// expense-intake/test/google-auth.test.js
import crypto from 'node:crypto';
import { getGoogleAccessToken } from '../src/google-auth.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function generateTestServiceAccount() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    serviceAccount: { client_email: 'test-sa@test-project.iam.gserviceaccount.com', private_key: privateKey },
    publicKey,
  };
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function fakeFetch(ok, status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  const { serviceAccount, publicKey } = generateTestServiceAccount();

  // happy path: builds and signs a real JWT, exchanges it, returns the access token
  const fetchImpl = fakeFetch(true, 200, { access_token: 'ya29.fake_token', token_type: 'Bearer', expires_in: 3600 });
  const token = await getGoogleAccessToken({ serviceAccountJson: serviceAccount, fetchImpl, now: () => 1735689600000 });
  assert(token === 'ya29.fake_token', 'getGoogleAccessToken must return the access_token from the response');

  const call = fetchImpl.calls[0];
  assert(call.url === 'https://oauth2.googleapis.com/token', 'must POST to the Google token endpoint');
  const bodyParams = new URLSearchParams(call.init.body);
  assert(bodyParams.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'must use the JWT bearer grant type');
  const jwt = bodyParams.get('assertion');
  assert(jwt, 'must send a signed JWT as the assertion parameter');

  // the JWT must actually verify against the service account's real public key —
  // this is the thing that would catch a broken signing implementation
  const [encodedHeader, encodedClaimSet, encodedSignature] = jwt.split('.');
  const header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8'));
  const claimSet = JSON.parse(base64UrlDecode(encodedClaimSet).toString('utf8'));
  assert(header.alg === 'RS256', 'JWT header must specify RS256');
  assert(claimSet.iss === 'test-sa@test-project.iam.gserviceaccount.com', 'JWT claim set must carry the service account email as iss');
  assert(claimSet.scope === 'https://www.googleapis.com/auth/spreadsheets', 'JWT claim set must request the Sheets scope');
  assert(claimSet.aud === 'https://oauth2.googleapis.com/token', 'JWT claim set aud must be the token endpoint');
  assert(claimSet.exp === claimSet.iat + 3600, 'JWT must expire exactly 1 hour after issuance');

  const signingInput = `${encodedHeader}.${encodedClaimSet}`;
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(signingInput);
  const signatureValid = verifier.verify(publicKey, base64UrlDecode(encodedSignature));
  assert(signatureValid, "the JWT signature must verify against the service account's real public key");

  // error path: Google rejects the token request
  const failFetch = fakeFetch(false, 400, { error: 'invalid_grant', error_description: 'Invalid JWT signature' });
  let threw = false;
  try {
    await getGoogleAccessToken({ serviceAccountJson: serviceAccount, fetchImpl: failFetch });
  } catch (err) {
    threw = true;
    assert(err.message === 'Invalid JWT signature', "must surface Google's error_description");
  }
  assert(threw, 'a non-2xx token response must throw');

  // accepts a JSON string for serviceAccountJson too (as it would come from an env secret)
  const stringFetch = fakeFetch(true, 200, { access_token: 'ya29.from_string', token_type: 'Bearer', expires_in: 3600 });
  const tokenFromString = await getGoogleAccessToken({ serviceAccountJson: JSON.stringify(serviceAccount), fetchImpl: stringFetch });
  assert(tokenFromString === 'ya29.from_string', 'must accept serviceAccountJson as a raw JSON string (as stored in a Worker secret)');

  console.log('PASS: google-auth.test.js');
}

await main();
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/google-auth.test.js`
Expected: fails with a module-not-found error for `../src/google-auth.js`.

- [x] **Step 3: Write the module**

```js
// expense-intake/src/google-auth.js
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function base64UrlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeString(str) {
  return base64UrlEncode(new TextEncoder().encode(str));
}

function pemToArrayBuffer(pem) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function signJwt(claimSet, privateKeyPem) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncodeString(JSON.stringify(header));
  const encodedClaimSet = base64UrlEncodeString(JSON.stringify(claimSet));
  const signingInput = `${encodedHeader}.${encodedClaimSet}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const encodedSignature = base64UrlEncode(signature);

  return `${signingInput}.${encodedSignature}`;
}

export async function getGoogleAccessToken({ serviceAccountJson, fetchImpl, now }) {
  const account = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  const getNow = now || Date.now;
  const nowSeconds = Math.floor(getNow() / 1000);
  const claimSet = {
    iss: account.client_email,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const jwt = await signJwt(claimSet, account.private_key);

  const doFetch = fetchImpl || fetch;
  const response = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
  });
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.error_description) || (data && data.error) || `Google token request failed with status ${response.status}`;
    throw new Error(message);
  }
  if (typeof data.access_token !== 'string') {
    throw new Error('Google token response missing access_token');
  }
  return data.access_token;
}
```

- [x] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './providers/index.test.js';
import './twilio.test.js';
import './receipt-storage.test.js';
import './db.test.js';
import './google-auth.test.js';
import './handlers.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 5: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: all eleven test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/google-auth.js expense-intake/test/google-auth.test.js expense-intake/test/run-all.js
```

---

### Task 12: Google Sheets row append

**Files:**
- Create: `expense-intake/src/sheets.js`
- Create: `expense-intake/test/sheets.test.js`
- Modify: `expense-intake/test/run-all.js`

- [x] **Step 1: Write the failing test**

```js
// expense-intake/test/sheets.test.js
import { appendExpenseRow } from '../src/sheets.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function fakeFetch(ok, status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  const okBody = { spreadsheetId: 'sheet123', updates: { updatedRows: 1 } };
  const fetchImpl = fakeFetch(true, 200, okBody);
  const row = ['2026-08-17', 'Home Depot', 42.5, 'Materials', 0.9, 'https://x/receipts/key.jpg', 'HD $42.50', '+15551234567', ''];

  const result = await appendExpenseRow({ accessToken: 'ya29.token', spreadsheetId: 'sheet123', row, fetchImpl });
  assert(result === okBody, 'appendExpenseRow must return the parsed response body');

  const call = fetchImpl.calls[0];
  assert(call.url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/sheet123/values/'), 'must hit the values:append endpoint for the given spreadsheetId');
  assert(call.url.includes(':append'), 'must use the :append action');
  assert(call.url.includes('valueInputOption=USER_ENTERED'), "must use USER_ENTERED so numbers/dates are interpreted, not stored as literal text (required for the Tax Rollup tab's SUM to work)");
  assert(call.url.includes('insertDataOption=INSERT_ROWS'), 'must use INSERT_ROWS so appending never overwrites existing data');
  assert(call.init.headers.Authorization === 'Bearer ya29.token', 'must send the access token as a Bearer token');
  const body = JSON.parse(call.init.body);
  assert(Array.isArray(body.values) && body.values.length === 1 && JSON.stringify(body.values[0]) === JSON.stringify(row), 'must wrap the row in a single-row values array');

  // error path
  const failFetch = fakeFetch(false, 403, { error: { message: 'The caller does not have permission' } });
  let threw = false;
  try {
    await appendExpenseRow({ accessToken: 'bad', spreadsheetId: 'sheet123', row, fetchImpl: failFetch });
  } catch (err) {
    threw = true;
    assert(err.message === 'The caller does not have permission', 'must surface the Sheets API error message');
  }
  assert(threw, 'a non-2xx Sheets API response must throw');

  console.log('PASS: sheets.test.js');
}

await main();
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/sheets.test.js`
Expected: fails with a module-not-found error for `../src/sheets.js`.

- [x] **Step 3: Write the module**

```js
// expense-intake/src/sheets.js
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export async function appendExpenseRow({ accessToken, spreadsheetId, row, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const range = encodeURIComponent('Sheet1!A:I');
  const url = `${SHEETS_API_BASE}/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: [row] }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.error && data.error.message) || `Sheets API request failed with status ${response.status}`;
    throw new Error(message);
  }
  return data;
}
```

- [x] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './providers/index.test.js';
import './twilio.test.js';
import './receipt-storage.test.js';
import './db.test.js';
import './google-auth.test.js';
import './sheets.test.js';
import './handlers.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 5: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: all twelve test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/sheets.js expense-intake/test/sheets.test.js expense-intake/test/run-all.js
```

---

### Task 13: TwiML response builder

**Files:**
- Create: `expense-intake/src/twiml.js`
- Create: `expense-intake/test/twiml.test.js`
- Modify: `expense-intake/test/run-all.js`

- [x] **Step 1: Write the failing test**

```js
// expense-intake/test/twiml.test.js
import { buildTwiml } from '../src/twiml.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  assert(buildTwiml('') === '<Response></Response>', 'an empty message body must produce a bare empty Response');
  assert(buildTwiml(null) === '<Response></Response>', 'a null message body must produce a bare empty Response');
  assert(buildTwiml('Logged: $42.50, Materials, Main St.') === '<Response><Message>Logged: $42.50, Materials, Main St.</Message></Response>', 'a message body must be wrapped in a <Message> tag');
  assert(buildTwiml('Tom & Jerry <3') === '<Response><Message>Tom &amp; Jerry &lt;3</Message></Response>', 'special XML characters must be escaped so the TwiML stays well-formed');

  console.log('PASS: twiml.test.js');
}

await main();
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/twiml.test.js`
Expected: fails with a module-not-found error for `../src/twiml.js`.

- [x] **Step 3: Write the module**

```js
// expense-intake/src/twiml.js
function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildTwiml(messageBody) {
  if (!messageBody) {
    return '<Response></Response>';
  }
  return `<Response><Message>${escapeXml(messageBody)}</Message></Response>`;
}
```

- [x] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './providers/index.test.js';
import './twilio.test.js';
import './receipt-storage.test.js';
import './db.test.js';
import './google-auth.test.js';
import './sheets.test.js';
import './twiml.test.js';
import './handlers.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 5: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: all thirteen test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/twiml.js expense-intake/test/twiml.test.js expense-intake/test/run-all.js
```

---

### Task 14: Public photo-serving route

**Files:**
- Create: `expense-intake/test/handlers.test.js` additions (this file doesn't exist as a Step 4 artifact yet in isolation — see Note below)
- Modify: `expense-intake/src/handlers.js` (add `handleGetReceipt`, additive only — does not touch `handleSmsWebhook`)
- Modify: `expense-intake/src/index.js` (add `GET /receipts/:key`)
- Modify: `expense-intake/test/handlers.test.js`
- Modify: `expense-intake/test/index.test.js`

**Note:** `handlers.js`/`handlers.test.js`/`index.js`/`index.test.js` already exist from Step 3 (Task 9) and get a much larger rewrite in Task 17 later (when `handleSmsWebhook`'s signature changes to wire in the new parsing pipeline). This task deliberately only *adds* `handleGetReceipt` and its route — it does not touch `handleSmsWebhook` at all, so it can be built, tested, and staged independently before that larger rewrite.

- [x] **Step 1: Write the failing test**

Add this to the end of `expense-intake/test/handlers.test.js`'s `main()` function, before the `console.log('PASS: handlers.test.js');` line, and add the import:

```js
// expense-intake/test/handlers.test.js — add this import at the top, alongside the existing ones
import { handleSmsWebhook, handleGetReceipt } from '../src/handlers.js';
```

```js
// expense-intake/test/handlers.test.js — add before the final console.log in main()

  // handleGetReceipt: found
  {
    const bucket = createFakeR2Bucket();
    await bucket.put('receipts/x/1.jpg', new ArrayBuffer(4), { httpMetadata: { contentType: 'image/jpeg' } });
    const found = await handleGetReceipt({ key: 'receipts/x/1.jpg', bucket });
    assert(found.status === 200 && found.contentType === 'image/jpeg', 'a stored photo must be served with its stored content type');
  }

  // handleGetReceipt: not found
  {
    const bucket = createFakeR2Bucket();
    const missing = await handleGetReceipt({ key: 'receipts/nope.jpg', bucket });
    assert(missing.status === 404, 'a missing key must 404');
  }
```

Also add this to `expense-intake/test/index.test.js`, before its final `console.log('PASS: index.test.js');`:

```js
// expense-intake/test/index.test.js — add before the final console.log in main()

  // GET /receipts/:key through the real routing layer
  const receiptBucket = createFakeR2Bucket();
  await receiptBucket.put('receipts/x/1.jpg', new ArrayBuffer(4), { httpMetadata: { contentType: 'image/jpeg' } });
  request = new Request('https://expense-intake.example.com/receipts/' + encodeURIComponent('receipts/x/1.jpg'), { method: 'GET' });
  response = await workerModule.fetch(request, baseEnv(createFakeImagesBinding(new ArrayBuffer(0)), receiptBucket));
  assert(response.status === 200 && response.headers.get('Content-Type') === 'image/jpeg', 'a stored receipt photo must be served through the real GET /receipts/:key route');

  // GET /receipts/:key for a missing key -> 404
  request = new Request('https://expense-intake.example.com/receipts/' + encodeURIComponent('receipts/nope.jpg'), { method: 'GET' });
  response = await workerModule.fetch(request, baseEnv(createFakeImagesBinding(new ArrayBuffer(0)), createFakeR2Bucket()));
  assert(response.status === 404, 'a missing receipt key must 404 through the real route');
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node expense-intake/test/handlers.test.js` and `node expense-intake/test/index.test.js`
Expected: both fail — `handleGetReceipt` doesn't exist yet, and `GET /receipts/:key` isn't routed yet (falls through to 404, but the "found" case's assertion on `Content-Type: image/jpeg` fails since the 404 fallback returns `application/json`).

- [x] **Step 3: Add `handleGetReceipt` to `src/handlers.js`**

Add this export to the end of `expense-intake/src/handlers.js` (keep everything already there from Step 3 unchanged):

```js
// expense-intake/src/handlers.js — add this export, keep everything else in the file as-is

export async function handleGetReceipt({ key, bucket }) {
  const object = await bucket.get(key);
  if (!object) {
    return { status: 404, contentType: 'text/plain', body: 'Not found' };
  }
  const bytes = await object.arrayBuffer();
  const contentType = (object.httpMetadata && object.httpMetadata.contentType) || 'image/jpeg';
  return { status: 200, contentType, body: bytes };
}
```

- [x] **Step 4: Wire the route into `src/index.js`**

Add this route block to `expense-intake/src/index.js`, right after the existing `POST /sms` block (keep everything else in the file — the `/sms` route, the import line, the 404 fallback — unchanged):

```js
// expense-intake/src/index.js — add this block after the POST /sms route, and add
// handleGetReceipt to the existing import from './handlers.js'

    if (request.method === 'GET' && url.pathname.startsWith('/receipts/')) {
      const key = decodeURIComponent(url.pathname.slice('/receipts/'.length));
      const result = await handleGetReceipt({ key, bucket: env.RECEIPTS_BUCKET });
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      });
    }
```

- [x] **Step 5: Run tests to verify they pass**

Run: `node expense-intake/test/run-all.js`
Expected: all thirteen test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/handlers.js expense-intake/src/index.js expense-intake/test/handlers.test.js expense-intake/test/index.test.js
```

---

### Task 15: Expense-flow orchestration (parse → categorize → file)

**Files:**
- Create: `expense-intake/src/expense-flow.js`
- Create: `expense-intake/test/expense-flow.test.js`
- Modify: `expense-intake/test/run-all.js`

This is the module that implements all the branching logic from this step's Design decisions note: house resolution, confidence branching, `expenses`/`pending_review` writes, and the Sheets write. It does not build TwiML or touch the HTTP layer — Task 17 wires this into `handleSmsWebhook`.

- [x] **Step 1: Write the failing test**

```js
// expense-intake/test/expense-flow.test.js
import crypto from 'node:crypto';
import { processExpenseMessage } from '../src/expense-flow.js';
import { createFakeD1 } from './fake-d1.js';
import { createFakeR2Bucket } from './fake-r2.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function generateTestServiceAccount() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { client_email: 'test-sa@test.iam.gserviceaccount.com', private_key: privateKey };
}

function chatResponse(content) {
  return { choices: [{ message: { content } }] };
}

function dispatchFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    for (const [match, respond] of handlers) {
      if (url.includes(match)) return respond(url, init);
    }
    throw new Error(`Unhandled fetch in test: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function jsonOk(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

async function withStoredPhoto(bucket, key) {
  await bucket.put(key, new ArrayBuffer(4), { httpMetadata: { contentType: 'image/jpeg' } });
}

function baseEnv(db, bucket, overrides = {}) {
  return {
    DB: db,
    RECEIPTS_BUCKET: bucket,
    AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'or_key',
    GOOGLE_SERVICE_ACCOUNT_JSON: generateTestServiceAccount(),
    WORKER_BASE_URL: 'https://expense-intake.example.workers.dev',
    ...overrides,
  };
}

function openRouterHandler(parseContent, copyContent) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const isParse = body.messages.some((m) => Array.isArray(m.content));
    const content = isParse ? parseContent : copyContent;
    return { ok: true, status: 200, json: async () => chatResponse(content) };
  };
}

async function main() {
  const client = { id: 1, twilio_number: '+15559876543' };
  const sender = { id: 5, client_id: 1, phone_number: '+15551234567' };
  const singleHouse = [{ id: 10, client_id: 1, address: '123 Main St', nickname: 'Main St', google_sheet_id: 'sheet_abc' }];

  // 1. Happy path: single house, high confidence, photo message
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    await withStoredPhoto(bucket, 'receipts/x/1.jpg');
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc' })],
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.9, raw_text: 'HD $42.50' }),
        'Logged: $42.50, Materials, Main St.'
      )],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: '', media: [] },
      photoR2Key: 'receipts/x/1.jpg',
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a high-confidence happy path must produce a confirmation SMS body');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert, 'a high-confidence match must insert an expenses row');
    assert(expenseInsert.params[4] === 'Materials', 'the inserted expense must carry the parsed category');
    const sheetsCall = fetchImpl.calls.find((c) => c.url.includes('sheets.googleapis.com'));
    assert(sheetsCall, 'a high-confidence match must append a row to the house Sheet');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(!pendingInsert, 'a high-confidence match must not also write to pending_review');
  }

  // 2. Low confidence: single house, low-confidence parse -> pending_review, not expenses
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: null, amount: null, category: 'Other', confidence: 0.2, raw_text: 'blurry' }),
        'Saved under Other — flagged for review.'
      )],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'some note', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a low-confidence match must still produce an SMS body');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'a low-confidence match must write to pending_review');
    assert(pendingInsert.params[1] === 10, 'a low-confidence match with a known house must still record that house_id in pending_review');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(!expenseInsert, 'a low-confidence match must not write to expenses');
    const sheetsCall = fetchImpl.calls.find((c) => c.url.includes('sheets.googleapis.com'));
    assert(!sheetsCall, 'a low-confidence match must not touch the Sheet');
  }

  // 3. Ambiguous house (two houses): pending_review with house_id null, house_selection copy
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'Lowes', amount: 10, category: 'Materials', confidence: 0.95, raw_text: 'Lowes $10' }),
        'Which house is this for?'
      )],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'Lowes $10', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'an ambiguous house must still produce a prompt SMS body');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'an ambiguous house must write to pending_review even with high confidence');
    assert(pendingInsert.params[1] === null, "an ambiguous house must record a null house_id, since we don't know which one");
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(!expenseInsert, 'an ambiguous house must never write directly to expenses, regardless of confidence');
  }

  // 4. Unknown client: silent ack, no writes
  {
    const db = createFakeD1({ 'SELECT * FROM clients WHERE twilio_number = ?': null });
    const bucket = createFakeR2Bucket();
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+10000000000', body: 'hi', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: {},
    });
    assert(result.smsBody === '', 'an unrecognized Twilio "To" number must produce a silent (empty) acknowledgment');
    assert(db.calls.length === 1, 'an unknown client must not proceed past the initial client lookup');
  }

  // 5. Unauthorized sender: silent ack
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': null,
    });
    const bucket = createFakeR2Bucket();
    const result = await processExpenseMessage({
      fields: { from: '+19998887777', to: '+15559876543', body: 'hi', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: {},
    });
    assert(result.smsBody === '', 'an unauthorized sender must produce a silent (empty) acknowledgment');
  }

  // 6. Empty message (no body, no photo): silent ack, no D1 lookups at all
  {
    const db = createFakeD1();
    const bucket = createFakeR2Bucket();
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: '', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: {},
    });
    assert(result.smsBody === '', 'a genuinely empty message must produce a silent acknowledgment');
    assert(db.calls.length === 0, 'a genuinely empty message must short-circuit before any D1 lookups');
  }

  // 7. Parse failure: treated as confidence 0, routed to pending_review
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', async (url, init) => {
        const body = JSON.parse(init.body);
        const isParse = body.messages.some((m) => Array.isArray(m.content));
        if (isParse) {
          return { ok: false, status: 500, json: async () => ({ error: { message: 'upstream error' } }) };
        }
        // Only the parse call should fail in this scenario — the subsequent
        // generateSmsCopy('low_confidence', ...) call must still succeed, since this
        // test is isolating "parseExpense fails" from "generateSmsCopy fails" (scenario 9,
        // below, covers the latter — safeGenerateSmsCopy's fallback path).
        return { ok: true, status: 200, json: async () => chatResponse('Saved under Uncategorized — flagged for review.') };
      }],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'something', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a parse failure must still produce a low-confidence-style SMS body, not crash the whole message');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'a parse failure must fall back to pending_review');
    assert(pendingInsert.params[6] === 0, 'a parse failure must record confidence 0, not a fabricated value');
  }

  // 8. Missing google_sheet_id on the resolved house: throws (a config gap, not silently swallowed)
  {
    const houseWithoutSheet = [{ id: 12, client_id: 1, address: '789 Pine Rd', nickname: null, google_sheet_id: null }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': houseWithoutSheet,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'X', amount: 1, category: 'Other', confidence: 0.99, raw_text: 'X $1' }),
        'unused'
      )],
    ]);
    let threw = false;
    try {
      await processExpenseMessage({
        fields: { from: '+15551234567', to: '+15559876543', body: 'X $1', media: [] },
        photoR2Key: null,
        env: baseEnv(db, bucket),
        deps: { fetchImpl },
      });
    } catch (err) {
      threw = true;
      assert(/google_sheet_id/.test(err.message), 'the error must clearly identify the missing google_sheet_id, not fail with a generic message');
    }
    assert(threw, 'a house with no Sheet configured must throw rather than silently losing a would-be-filed expense');
  }

  // 9. generateSmsCopy fails AFTER the write already succeeded (high confidence): the
  // pipeline must still complete with fallback copy, not throw — a throw here would mean
  // nothing gets cached (Task 16) and Twilio would retry, re-writing a second Sheet row and
  // a second expenses row for a receipt that was already successfully filed. This is the
  // Critical gap the whole-step review caught: safeGenerateSmsCopy's fallback is what
  // closes it.
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc' })],
      ['openrouter.ai', async (url, init) => {
        const body = JSON.parse(init.body);
        const isParse = body.messages.some((m) => Array.isArray(m.content));
        if (isParse) {
          return { ok: true, status: 200, json: async () => chatResponse(JSON.stringify({ vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.9, raw_text: 'HD $42.50' })) };
        }
        // The copy-generation call fails — this is the exact scenario the fallback exists for
        return { ok: false, status: 500, json: async () => ({ error: { message: 'upstream error' } }) };
      }],
    ]);
    const result = await processExpenseMessage({
      // Non-empty body (rather than '') so this doesn't trip the module's own
      // `!fields.body && !photoR2Key` early-return guard before reaching the write path —
      // the mock's canned parse response doesn't depend on the actual text content.
      fields: { from: '+15551234567', to: '+15559876543', body: 'HD $42.50', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody === 'Logged: $42.50, Materials, Main St.', 'a generateSmsCopy failure after a successful write must fall back to static confirmation copy with the real values substituted, not throw');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert, 'the write must have already succeeded before the copy-generation failure — this proves the fallback path is reached post-write, not a case where the write itself was skipped');
  }

  // 10. generateSmsCopy fails on the ambiguous-house (house_selection) path: must still
  // fall back to static copy, and the pending_review write (house_id null) must have
  // already happened. Mirrors scenario 9 but for the house_selection call site.
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', async (url, init) => {
        const body = JSON.parse(init.body);
        const isParse = body.messages.some((m) => Array.isArray(m.content));
        if (isParse) {
          return { ok: true, status: 200, json: async () => chatResponse(JSON.stringify({ vendor: 'Lowes', amount: 10, category: 'Materials', confidence: 0.95, raw_text: 'Lowes $10' })) };
        }
        // The copy-generation call fails — this is the exact scenario the fallback exists for
        return { ok: false, status: 500, json: async () => ({ error: { message: 'upstream error' } }) };
      }],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'Lowes $10', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody === 'Which house is this for? Address or nickname works.', 'a generateSmsCopy failure on the ambiguous-house path must fall back to static house_selection copy, not throw');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'the pending_review write must have already succeeded before the copy-generation failure');
    assert(pendingInsert.params[1] === null, 'the ambiguous-house pending_review write must still record a null house_id');
  }

  // 11. generateSmsCopy fails on the low-confidence path: must still fall back to static
  // copy with the real category substituted, and the pending_review write must have already
  // happened. Mirrors scenario 9 but for the low_confidence call site.
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', async (url, init) => {
        const body = JSON.parse(init.body);
        const isParse = body.messages.some((m) => Array.isArray(m.content));
        if (isParse) {
          return { ok: true, status: 200, json: async () => chatResponse(JSON.stringify({ vendor: null, amount: null, category: 'Other', confidence: 0.2, raw_text: 'blurry' })) };
        }
        // The copy-generation call fails — this is the exact scenario the fallback exists for
        return { ok: false, status: 500, json: async () => ({ error: { message: 'upstream error' } }) };
      }],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'some note', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody === "Logged this as Other but wasn't fully sure — flagged it for you to double check.", 'a generateSmsCopy failure on the low-confidence path must fall back to static low_confidence copy with the real category substituted, not throw');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'the pending_review write must have already succeeded before the copy-generation failure');
  }

  console.log('PASS: expense-flow.test.js');
}

await main();
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/expense-flow.test.js`
Expected: fails with a module-not-found error for `../src/expense-flow.js`.

- [x] **Step 3: Write the module**

```js
// expense-intake/src/expense-flow.js
import { parseExpense, generateSmsCopy } from './providers/index.js';
import { findClientByTwilioNumber, findAuthorizedSender, findHousesForClient, insertExpense, insertPendingReview } from './db.js';
import { getGoogleAccessToken } from './google-auth.js';
import { appendExpenseRow } from './sheets.js';

const CONFIDENCE_THRESHOLD = 0.7; // tunable — see Step 4's Design decisions note in the plan
const PENDING_REVIEW_TTL_DAYS = 60; // matches spec's 60-day auto-purge (Cron Trigger is Build Order step 7)

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function pendingReviewExpiresAt() {
  return new Date(Date.now() + PENDING_REVIEW_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function receiptPhotoUrl(baseUrl, photoR2Key) {
  return `${baseUrl}/receipts/${encodeURIComponent(photoR2Key)}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function loadStoredPhotoAsImageInput(bucket, photoR2Key) {
  const object = await bucket.get(photoR2Key);
  if (!object) {
    throw new Error(`Stored receipt photo not found in R2: ${photoR2Key}`);
  }
  const bytes = await object.arrayBuffer();
  return { base64: arrayBufferToBase64(bytes), mediaType: 'image/jpeg' };
}

// Static fallback copy, used only if the AI copy-generation call itself fails. Deliberately
// NOT the raw SMS_COPY_ANCHORS strings from providers/shared.js (Step 2) — those contain
// literal bracket placeholders like "[amount]" meant only as few-shot prompt examples, never
// meant to be sent to a client verbatim. These fallbacks substitute the real values instead.
const FALLBACK_SMS_COPY = {
  confirmation: (vars) => `Logged: $${vars.amount}, ${vars.category}, ${vars.house}.`,
  low_confidence: (vars) => `Logged this as ${vars.category} but wasn't fully sure — flagged it for you to double check.`,
  house_selection: () => 'Which house is this for? Address or nickname works.',
};

// A copy-generation failure must never re-trigger writes that already succeeded. By the
// time this is called, `insertExpense`/`appendExpenseRow` or `insertPendingReview` have
// already committed — if generateSmsCopy then throws (rate limit, timeout, network blip,
// all realistic for an external API call) and that exception were allowed to propagate,
// handleSmsWebhook's outer catch would turn it into a 500, Twilio would retry the whole
// webhook, and — since nothing gets cached on a 500 (Task 16) — the retry would reprocess
// from scratch: a second Sheet row, a second expenses/pending_review row, for one physical
// receipt. That's the exact duplicate-write problem Task 16 exists to prevent, reopened by
// an unrelated failure a few lines later. Falling back to static copy instead means the
// pipeline always finishes, gets cached, and Twilio never retries a message whose writes
// already succeeded.
async function safeGenerateSmsCopy(type, vars, env, deps) {
  try {
    return await generateSmsCopy(type, vars, env, deps);
  } catch (err) {
    console.error('generateSmsCopy failed, using fallback copy', { error: err.message, type });
    // Defensive: FALLBACK_SMS_COPY only covers the three types this module currently calls
    // with. If a future call site (e.g. Step 7's monthly_nudge Cron Trigger) invokes this
    // with a type that hasn't been given a fallback entry, FALLBACK_SMS_COPY[type] is
    // undefined — calling it would throw a TypeError from inside this catch block itself,
    // reopening the exact uncaught-exception bug this function exists to close. A generic
    // last-resort string keeps the guarantee unconditional.
    const fallback = FALLBACK_SMS_COPY[type];
    return fallback ? fallback(vars) : 'We logged this — reply if something looks off.';
  }
}

export async function processExpenseMessage({ fields, photoR2Key, env, deps = {} }) {
  if (!fields.body && !photoR2Key) {
    return { smsBody: '' };
  }

  const client = await findClientByTwilioNumber(env.DB, fields.to);
  if (!client) {
    return { smsBody: '' };
  }

  const sender = await findAuthorizedSender(env.DB, client.id, fields.from);
  if (!sender) {
    return { smsBody: '' };
  }

  const houses = await findHousesForClient(env.DB, client.id);
  const image = photoR2Key ? await loadStoredPhotoAsImageInput(env.RECEIPTS_BUCKET, photoR2Key) : null;

  let parsed = null;
  try {
    parsed = await parseExpense({ text: fields.body || null, image }, env, deps);
  } catch (err) {
    console.error('parseExpense failed', { error: err.message });
    parsed = null;
  }

  const houseIsAmbiguous = houses.length !== 1;

  if (houseIsAmbiguous) {
    await insertPendingReview(env.DB, {
      clientId: client.id,
      houseId: null,
      amountGuess: parsed ? parsed.amount : null,
      categoryGuess: parsed ? parsed.category : null,
      photoR2Key,
      rawText: parsed ? parsed.raw_text : (fields.body || ''),
      confidence: parsed ? parsed.confidence : 0,
      expiresAt: pendingReviewExpiresAt(),
    });
    const smsBody = await safeGenerateSmsCopy('house_selection', {}, env, deps);
    return { smsBody };
  }

  const house = houses[0];

  if (parsed && parsed.confidence >= CONFIDENCE_THRESHOLD && parsed.amount != null) {
    if (!house.google_sheet_id) {
      // A house with no Sheet set up is an onboarding gap, not a runtime parsing issue —
      // surface it loudly (visible in wrangler tail) rather than silently losing the expense
      // into pending_review, which would mask a real setup bug during manual (pre-step-9) onboarding.
      throw new Error(`House ${house.id} has no google_sheet_id configured`);
    }
    const accessToken = await getGoogleAccessToken({ serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON, fetchImpl: deps.fetchImpl });
    const photoUrl = photoR2Key ? receiptPhotoUrl(env.WORKER_BASE_URL, photoR2Key) : '';
    await appendExpenseRow({
      accessToken,
      spreadsheetId: house.google_sheet_id,
      row: [todayIso(), parsed.vendor, parsed.amount, parsed.category, parsed.confidence, photoUrl, parsed.raw_text, fields.from, ''],
      fetchImpl: deps.fetchImpl,
    });
    await insertExpense(env.DB, {
      houseId: house.id,
      date: todayIso(),
      vendor: parsed.vendor,
      amount: parsed.amount,
      category: parsed.category,
      confidence: parsed.confidence,
      photoR2Key,
      rawText: parsed.raw_text,
      loggedByPhone: fields.from,
      notes: '',
    });
    const smsBody = await safeGenerateSmsCopy('confirmation', {
      amount: parsed.amount != null ? parsed.amount.toFixed(2) : '0.00',
      category: parsed.category,
      house: house.nickname || house.address,
    }, env, deps);
    return { smsBody };
  }

  await insertPendingReview(env.DB, {
    clientId: client.id,
    houseId: house.id,
    amountGuess: parsed ? parsed.amount : null,
    categoryGuess: parsed ? parsed.category : null,
    photoR2Key,
    rawText: parsed ? parsed.raw_text : (fields.body || ''),
    confidence: parsed ? parsed.confidence : 0,
    expiresAt: pendingReviewExpiresAt(),
  });
  const smsBody = await safeGenerateSmsCopy('low_confidence', {
    category: parsed ? parsed.category : 'Uncategorized',
  }, env, deps);
  return { smsBody };
}
```

- [x] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './providers/index.test.js';
import './twilio.test.js';
import './receipt-storage.test.js';
import './db.test.js';
import './google-auth.test.js';
import './sheets.test.js';
import './twiml.test.js';
import './expense-flow.test.js';
import './handlers.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 5: Run test to verify it passes**

Run: `node expense-intake/test/run-all.js`
Expected: all fourteen test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/expense-flow.js expense-intake/test/expense-flow.test.js expense-intake/test/run-all.js
```

---

### Task 16: Twilio message deduplication (idempotency against webhook retries)

**Files:**
- Modify: `expense-intake/src/twilio.js` (add `messageSid` to `extractWebhookFields`)
- Modify: `expense-intake/test/twilio.test.js`
- Create: `expense-intake/src/message-dedup.js`
- Create: `expense-intake/test/fake-kv.js`
- Create: `expense-intake/test/message-dedup.test.js`
- Modify: `expense-intake/test/run-all.js`
- Modify: `expense-intake/wrangler.toml`

**Why this task exists:** Task 15's code review surfaced a real gap — Twilio retries webhook delivery on a 5xx response or a dropped/slow reply, and nothing in the pipeline could tell a retry apart from a genuinely new message. A retry after the Sheet/D1 writes already succeeded (but before Twilio got the 200) would re-run `processExpenseMessage` from scratch: a second Sheet row and a second `expenses`/`pending_review` row for one physical receipt. The project owner confirmed fixing this now rather than deferring it, since it's a financial-data-integrity issue.

**Design:**
- Twilio sends a unique `MessageSid` (e.g. `SMxxxxxxxx...`) with every inbound webhook — `extractWebhookFields` (Step 3) doesn't currently expose it; this task adds it as a fourth field, additive to the existing `{from, to, body, media}` shape.
- A new KV namespace, bound as `CONVERSATION_STATE` (matching the name already anticipated in `wrangler.toml`'s Step 1 scaffold comment — Build Order step 5 will reuse the same namespace for house-selection/correction-window state, not a second one), stores `processed:<messageSid> -> <the SMS reply body that was sent>` with a 24-hour TTL — comfortably longer than any realistic Twilio retry window, short enough not to grow the namespace indefinitely.
- The dedup check happens in `handleSmsWebhook` (Task 17, not yet built) immediately after signature verification, **before** photo storage or any parsing — a cache hit skips the entire pipeline (no re-fetching Twilio media, no re-calling the AI provider, no re-writing to Sheets/D1) and replays the cached reply as TwiML.
- The cache is written **only after** `processExpenseMessage` fully succeeds, right before responding — never at the start of processing. Marking "done" up front would risk a worse failure mode than duplication: a crash mid-processing would permanently (until TTL) mark a message as handled even though nothing was actually written, silently losing the expense on any subsequent retry. Marking after success means the realistic case this task targets (retry after full success, response just didn't make it back) is closed, while a narrower residual window remains — two invocations processing the *same* still-in-flight message concurrently (e.g. a slow AI call overlapping a retry) could still both complete and duplicate. Closing that fully would need atomic compare-and-swap (KV doesn't offer this; Durable Objects would), which isn't proportionate for this system yet — accepted as a known, documented residual limitation, not silently claimed as "fully solved."
- A cache write failure (KV hiccup) is caught and logged, not allowed to fail the whole response — losing dedup protection for one message is far better than failing to reply to Twilio at all over a KV outage.

- [x] **Step 1: Write the failing tests**

Add this to `expense-intake/test/twilio.test.js`'s `main()`, right after the existing "message with one photo" block:

```js
// expense-intake/test/twilio.test.js — add after the "extractWebhookFields: message with one photo" block

  // extractWebhookFields: messageSid is extracted for dedup purposes
  const withSid = extractWebhookFields({
    From: '+15551234567', To: '+15559876543', Body: 'hi', NumMedia: '0', MessageSid: 'SM1234567890abcdef',
  });
  assert(withSid.messageSid === 'SM1234567890abcdef', 'extractWebhookFields must expose MessageSid as messageSid');

  // extractWebhookFields: missing MessageSid defaults to an empty string, not undefined
  const noSid = extractWebhookFields({ From: '+1', To: '+2', Body: 'hi', NumMedia: '0' });
  assert(noSid.messageSid === '', 'a missing MessageSid must default to an empty string');
```

```js
// expense-intake/test/fake-kv.js
// Mirrors worker/test/fake-kv.js's shape, plus call recording (matching this project's
// fake-r2.js/fake-images.js convention) so tests can assert on put() options like expirationTtl.
export function createFakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = [];
  return {
    async get(key, options) {
      calls.push({ method: 'get', key, options });
      if (!store.has(key)) return null;
      const raw = store.get(key);
      if (options && options.type === 'json') {
        return JSON.parse(raw);
      }
      return raw;
    },
    async put(key, value, options) {
      calls.push({ method: 'put', key, value, options });
      store.set(key, value);
    },
    async delete(key) {
      calls.push({ method: 'delete', key });
      store.delete(key);
    },
    _store: store,
    calls,
  };
}
```

```js
// expense-intake/test/message-dedup.test.js
import { getCachedReply, cacheReply } from '../src/message-dedup.js';
import { createFakeKV } from './fake-kv.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  // getCachedReply: not yet cached
  const kv1 = createFakeKV();
  const miss = await getCachedReply(kv1, 'SM123');
  assert(miss === null, 'an unprocessed messageSid must return null');

  // cacheReply then getCachedReply: round trip
  const kv2 = createFakeKV();
  await cacheReply(kv2, 'SM456', 'Logged: $42.50, Materials, Main St.');
  const hit = await getCachedReply(kv2, 'SM456');
  assert(hit === 'Logged: $42.50, Materials, Main St.', 'a cached reply must be returned verbatim on the next lookup');

  // cacheReply stores under a processed:<messageSid> key with an expiration, so the
  // namespace doesn't grow forever
  const putCall = kv2.calls.find((c) => c.method === 'put' && c.key === 'processed:SM456');
  assert(putCall, 'cacheReply must store under a processed:<messageSid> key');
  assert(putCall.options && putCall.options.expirationTtl > 0, 'cacheReply must set an expirationTtl so dedup entries do not grow the KV namespace forever');

  // missing messageSid is a no-op, never treated as cached (defensive against a
  // malformed/legacy Twilio payload missing MessageSid entirely)
  const kv3 = createFakeKV();
  await cacheReply(kv3, '', 'should not be stored');
  assert(kv3.calls.every((c) => c.method !== 'put'), 'cacheReply must not write anything for an empty messageSid');
  const emptyLookup = await getCachedReply(kv3, '');
  assert(emptyLookup === null, 'getCachedReply must return null for an empty messageSid without querying KV');
  assert(kv3.calls.every((c) => c.method !== 'get'), 'getCachedReply must not query KV for an empty messageSid');

  console.log('PASS: message-dedup.test.js');
}

await main();
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node expense-intake/test/twilio.test.js`
Expected: fails — `extractWebhookFields` doesn't return `messageSid` yet.

Run: `node expense-intake/test/message-dedup.test.js`
Expected: fails with a module-not-found error for `../src/message-dedup.js`.

- [x] **Step 3: Add `messageSid` to `src/twilio.js`**

```js
// expense-intake/src/twilio.js — change only the final `return` line of extractWebhookFields,
// keep everything else in the file (the signature verification, the MAX_MEDIA_ITEMS cap, etc.) unchanged

  return { from: params.From || '', to: params.To || '', body: params.Body || '', media, messageSid: params.MessageSid || '' };
```

- [x] **Step 4: Write `src/message-dedup.js`**

```js
// expense-intake/src/message-dedup.js
const REPLY_CACHE_TTL_SECONDS = 24 * 60 * 60; // comfortably longer than any realistic Twilio retry window

export async function getCachedReply(kv, messageSid) {
  if (!messageSid) return null;
  return kv.get(`processed:${messageSid}`);
}

export async function cacheReply(kv, messageSid, smsBody) {
  if (!messageSid) return;
  await kv.put(`processed:${messageSid}`, smsBody, { expirationTtl: REPLY_CACHE_TTL_SECONDS });
}
```

- [x] **Step 5: Wire the new tests into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './providers/index.test.js';
import './twilio.test.js';
import './receipt-storage.test.js';
import './db.test.js';
import './google-auth.test.js';
import './sheets.test.js';
import './twiml.test.js';
import './expense-flow.test.js';
import './message-dedup.test.js';
import './handlers.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 6: Run tests to verify they pass**

Run: `node expense-intake/test/run-all.js`
Expected: all fifteen test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 7: Add the KV namespace binding to `wrangler.toml`**

```toml
# expense-intake/wrangler.toml — add this block (keep everything already there)

[[kv_namespaces]]
binding = "CONVERSATION_STATE"
id = "REPLACE_WITH_KV_NAMESPACE_ID"
```

Also update the trailing comment (it currently says KV is "added in later Build Order steps (5-7)" — that's no longer accurate now that this task adds it):

```toml
# expense-intake/wrangler.toml — replace the trailing comment

# CONVERSATION_STATE (above) is also used by Build Order step 5 for house-selection
# pending state and the 10-minute correction window — one namespace, multiple key
# prefixes ("processed:", and step 5's own prefix once it exists).
# Routes and [[triggers]] cron entries are added in later Build Order steps (7-ish)
# once the code that uses them exists.
```

- [x] **Step 8: Stage the change**

```bash
git add expense-intake/src/twilio.js expense-intake/test/twilio.test.js expense-intake/src/message-dedup.js expense-intake/test/fake-kv.js expense-intake/test/message-dedup.test.js expense-intake/test/run-all.js expense-intake/wrangler.toml
```

---

### Task 17: Wire the parsing pipeline into `handleSmsWebhook`, bindings, and docs

**Files:**
- Modify: `expense-intake/src/handlers.js` (rewrite `handleSmsWebhook`; `handleGetReceipt` — already updated by Task 14's review fixes — is carried forward unchanged)
- Modify: `expense-intake/src/index.js` (pass `env` instead of individual bindings for `/sms`; the `GET /receipts/:key` route — already updated by Task 14's review fixes — is carried forward unchanged)
- Modify: `expense-intake/test/handlers.test.js` (full replacement)
- Modify: `expense-intake/test/index.test.js` (full replacement)
- Modify: `expense-intake/wrangler.toml`
- Modify: `expense-intake/README.md`

This changes `handleSmsWebhook`'s signature from Step 3's individually-destructured bindings (`accountSid, authToken, imagesBinding, bucket`) to taking `env` directly — a deliberate evolution now that this function's dependency surface has grown to include D1, the AI provider abstraction, Google auth, Sheets, and now KV (Task 16), on top of what it already needed. Continuing to destructure an ever-growing list of individual parameters would fight the pattern `src/providers/index.js` (Step 2) already established of taking `(input, env, deps)`. This task also wires in Task 16's dedup check/cache — the two were originally planned as one task, then split so the dedup logic (KV plumbing, `messageSid` capture) could be built and reviewed as its own self-contained unit before folding it into the rewrite that was already touching this exact function.

**Note on `handleGetReceipt`/`GET /receipts/:key`:** Task 14 already shipped both of these, and a code-review cycle already hardened them (a `receipts/` key-prefix guard in `handleGetReceipt`, and a try/catch around `decodeURIComponent` in the route). The code blocks below show their CURRENT, already-fixed form — copy them as-is, don't reconstruct from Task 14's original (pre-fix) plan text, which would silently revert those fixes.

- [x] **Step 1: Write the failing tests**

```js
// expense-intake/test/handlers.test.js — full replacement
import crypto from 'node:crypto';
import { handleSmsWebhook, handleGetReceipt } from '../src/handlers.js';
import { createFakeImagesBinding } from './fake-images.js';
import { createFakeR2Bucket } from './fake-r2.js';
import { createFakeD1 } from './fake-d1.js';
import { createFakeKV } from './fake-kv.js';
import { getCachedReply } from '../src/message-dedup.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function computeTwilioSignature(url, params, authToken) {
  const sortedKeys = Object.keys(params).sort();
  let stringToSign = url;
  for (const key of sortedKeys) {
    stringToSign += key + params[key];
  }
  return crypto.createHmac('sha1', authToken).update(stringToSign).digest('base64');
}

function fakeFetch(ok, status, body) {
  return async () => ({ ok, status, json: async () => body });
}

function baseEnv(overrides = {}) {
  return {
    TWILIO_ACCOUNT_SID: 'AC_test',
    TWILIO_AUTH_TOKEN: 'test_auth_token',
    IMAGES: createFakeImagesBinding(new ArrayBuffer(0)),
    RECEIPTS_BUCKET: createFakeR2Bucket(),
    DB: createFakeD1({ 'SELECT * FROM clients WHERE twilio_number = ?': null }),
    CONVERSATION_STATE: createFakeKV(),
    ...overrides,
  };
}

async function main() {
  const url = 'https://expense-intake.example.com/sms';
  const authToken = 'test_auth_token';

  // invalid signature -> 403, nothing stored, processExpenseMessage never reached
  {
    const env = baseEnv();
    const result = await handleSmsWebhook({
      url, bodyText: 'From=%2B1555&To=%2B1556&Body=hi&NumMedia=0', signature: 'bad-sig', env,
    });
    assert(result.status === 403, 'an invalid signature must return 403');
  }

  // valid signature, unknown client -> 200, empty TwiML (silent ack from processExpenseMessage);
  // also confirms a successful (even silently-empty) response gets cached under its messageSid
  {
    const params = { From: '+15551234567', To: '+19998887777', Body: 'hello', NumMedia: '0', MessageSid: 'SM_unknown_client' };
    const bodyText = new URLSearchParams(params).toString();
    const signature = computeTwilioSignature(url, params, authToken);
    const kv = createFakeKV();
    const env = baseEnv({ DB: createFakeD1({ 'SELECT * FROM clients WHERE twilio_number = ?': null }), CONVERSATION_STATE: kv });
    const result = await handleSmsWebhook({ url, bodyText, signature, env });
    assert(result.status === 200 && result.contentType === 'text/xml' && result.body === '<Response></Response>', 'an unrecognized client must still 200 with an empty TwiML acknowledgment');
    const cached = await getCachedReply(kv, 'SM_unknown_client');
    assert(cached === '', 'a successfully-handled message (even a silent ack) must be cached under its messageSid so a Twilio retry replays it instead of reprocessing');
  }

  // photo storage failure -> 500, processExpenseMessage never reached, and nothing gets
  // cached (a failed attempt must be retryable for real, not permanently marked "done")
  {
    const params = {
      From: '+15551234567', To: '+15559876543', Body: '', NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/ME_missing', MediaContentType0: 'image/jpeg', MessageSid: 'SM_photo_fail',
    };
    const bodyText = new URLSearchParams(params).toString();
    const signature = computeTwilioSignature(url, params, authToken);
    const failBucket = createFakeR2Bucket();
    const kv = createFakeKV();
    const env = baseEnv({ RECEIPTS_BUCKET: failBucket, CONVERSATION_STATE: kv });
    const result = await handleSmsWebhook({ url, bodyText, signature, env, deps: { fetchImpl: fakeFetch(false, 404, null) } });
    assert(result.status === 500, 'a failed photo storage must still return 500 so Twilio retries delivery');
    assert(failBucket._store.size === 0, 'nothing should be stored in R2 when photo storage fails');
    assert((await getCachedReply(kv, 'SM_photo_fail')) === null, 'a failed attempt must not be cached, so a real Twilio retry can actually retry it');
  }

  // processExpenseMessage throwing -> 500 (e.g. a house with no google_sheet_id, or a DB
  // outage), and nothing gets cached, same reasoning as the photo-storage-failure case
  {
    const params = { From: '+15551234567', To: '+15559876543', Body: 'hello', NumMedia: '0', MessageSid: 'SM_process_fail' };
    const bodyText = new URLSearchParams(params).toString();
    const signature = computeTwilioSignature(url, params, authToken);
    const throwingDb = {
      prepare() {
        return { bind() { return this; }, async first() { throw new Error('DB unavailable'); } };
      },
    };
    const kv = createFakeKV();
    const env = baseEnv({ DB: throwingDb, CONVERSATION_STATE: kv });
    const result = await handleSmsWebhook({ url, bodyText, signature, env });
    assert(result.status === 500, 'an unexpected error while processing the message must return 500, not crash the Worker');
    assert((await getCachedReply(kv, 'SM_process_fail')) === null, 'a failed attempt must not be cached');
  }

  // repeated MessageSid (Twilio retry after we already fully processed it) -> replay the
  // cached reply without touching D1/R2/the AI provider at all
  {
    const params = { From: '+15551234567', To: '+15559876543', Body: 'hello', NumMedia: '0', MessageSid: 'SM_retry_test' };
    const bodyText = new URLSearchParams(params).toString();
    const signature = computeTwilioSignature(url, params, authToken);
    const throwingDb = {
      prepare() {
        throw new Error('D1 should never be queried on a dedup cache hit');
      },
    };
    const kv = createFakeKV({ 'processed:SM_retry_test': 'Logged: $42.50, Materials, Main St.' });
    const env = baseEnv({ DB: throwingDb, CONVERSATION_STATE: kv });
    const result = await handleSmsWebhook({ url, bodyText, signature, env });
    assert(result.status === 200 && result.contentType === 'text/xml', 'a cache hit must still return 200 TwiML');
    assert(result.body === '<Response><Message>Logged: $42.50, Materials, Main St.</Message></Response>', 'a cache hit must replay the exact cached reply');
  }

  // handleGetReceipt: found
  {
    const bucket = createFakeR2Bucket();
    await bucket.put('receipts/x/1.jpg', new ArrayBuffer(4), { httpMetadata: { contentType: 'image/jpeg' } });
    const found = await handleGetReceipt({ key: 'receipts/x/1.jpg', bucket });
    assert(found.status === 200 && found.contentType === 'image/jpeg', 'a stored photo must be served with its stored content type');
  }

  // handleGetReceipt: not found
  {
    const bucket = createFakeR2Bucket();
    const missing = await handleGetReceipt({ key: 'receipts/nope.jpg', bucket });
    assert(missing.status === 404, 'a missing key must 404');
  }

  console.log('PASS: handlers.test.js');
}

await main();
```

```js
// expense-intake/test/index.test.js — full replacement
import crypto from 'node:crypto';
import workerModule from '../src/index.js';
import { createFakeImagesBinding } from './fake-images.js';
import { createFakeR2Bucket } from './fake-r2.js';
import { createFakeD1 } from './fake-d1.js';
import { createFakeKV } from './fake-kv.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function computeTwilioSignature(url, params, authToken) {
  const sortedKeys = Object.keys(params).sort();
  let stringToSign = url;
  for (const key of sortedKeys) {
    stringToSign += key + params[key];
  }
  return crypto.createHmac('sha1', authToken).update(stringToSign).digest('base64');
}

async function main() {
  // unrouted requests still 404
  let request = new Request('https://expense-intake.example.com/', { method: 'GET' });
  let response = await workerModule.fetch(request, {});
  assert(response.status === 404, 'unrouted requests should 404');

  const authToken = 'test_auth_token';
  const smsUrl = 'https://expense-intake.example.com/sms';
  function baseEnv(overrides = {}) {
    return {
      TWILIO_ACCOUNT_SID: 'AC_test',
      TWILIO_AUTH_TOKEN: authToken,
      IMAGES: createFakeImagesBinding(new ArrayBuffer(0)),
      RECEIPTS_BUCKET: createFakeR2Bucket(),
      DB: createFakeD1({ 'SELECT * FROM clients WHERE twilio_number = ?': null }),
      CONVERSATION_STATE: createFakeKV(),
      ...overrides,
    };
  }

  // POST /sms with an invalid signature is rejected, through the real routing layer
  request = new Request(smsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'not-a-real-signature' },
    body: 'From=%2B15551234567&To=%2B15559876543&Body=hello&NumMedia=0',
  });
  response = await workerModule.fetch(request, baseEnv());
  assert(response.status === 403, 'an invalid Twilio signature must be rejected with 403 through the real route');

  // POST /sms, text-only message with a valid signature, unknown client -> silent TwiML ack
  const textParams = { From: '+15551234567', To: '+15559876543', Body: 'hello', NumMedia: '0', MessageSid: 'SM_index_text' };
  const textSig = computeTwilioSignature(smsUrl, textParams, authToken);
  request = new Request(smsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': textSig },
    body: new URLSearchParams(textParams).toString(),
  });
  response = await workerModule.fetch(request, baseEnv());
  assert(response.status === 200, 'a validly signed text-only message should return 200 through the real route');
  assert(response.headers.get('Content-Type') === 'text/xml', 'the response to Twilio must be TwiML (text/xml)');
  const textBody = await response.text();
  assert(textBody.includes('<Response>'), 'the response body must be valid (if minimal) TwiML');

  // GET /receipts/:key through the real routing layer
  const receiptBucket = createFakeR2Bucket();
  await receiptBucket.put('receipts/x/1.jpg', new ArrayBuffer(4), { httpMetadata: { contentType: 'image/jpeg' } });
  request = new Request('https://expense-intake.example.com/receipts/' + encodeURIComponent('receipts/x/1.jpg'), { method: 'GET' });
  response = await workerModule.fetch(request, baseEnv({ RECEIPTS_BUCKET: receiptBucket }));
  assert(response.status === 200 && response.headers.get('Content-Type') === 'image/jpeg', 'a stored receipt photo must be served through the real GET /receipts/:key route');

  // GET /receipts/:key for a missing key -> 404
  request = new Request('https://expense-intake.example.com/receipts/' + encodeURIComponent('receipts/nope.jpg'), { method: 'GET' });
  response = await workerModule.fetch(request, baseEnv());
  assert(response.status === 404, 'a missing receipt key must 404 through the real route');

  console.log('PASS: index.test.js');
}

await main();
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node expense-intake/test/handlers.test.js`
Expected: fails — `handleSmsWebhook`'s current (Step 3) signature doesn't accept `env`, so calls with the old individually-destructured params are gone from the test and the new calls don't match the current implementation's expectations (e.g. `env.DB`/`env.CONVERSATION_STATE` are undefined inside the still-old `handleSmsWebhook`, or the unknown-client case doesn't get the empty-TwiML behavior since `processExpenseMessage` isn't wired in yet).

Run: `node expense-intake/test/index.test.js`
Expected: fails for the same underlying reason — `index.js` still calls `handleSmsWebhook` with Step 3's old individual-params signature.

- [x] **Step 3: Rewrite `src/handlers.js`**

```js
// expense-intake/src/handlers.js — full replacement
import { parseFormBody, verifyTwilioSignature, extractWebhookFields } from './twilio.js';
import { generateReceiptKey, storeReceiptPhoto } from './receipt-storage.js';
import { processExpenseMessage } from './expense-flow.js';
import { buildTwiml } from './twiml.js';
import { getCachedReply, cacheReply } from './message-dedup.js';

export async function handleSmsWebhook({ url, bodyText, signature, env, deps = {} }) {
  const params = parseFormBody(bodyText);
  const valid = await verifyTwilioSignature({ url, params, signature, authToken: env.TWILIO_AUTH_TOKEN });
  if (!valid) {
    return { status: 403, contentType: 'text/plain', body: 'Forbidden' };
  }

  const fields = extractWebhookFields(params);

  const cachedReply = await getCachedReply(env.CONVERSATION_STATE, fields.messageSid);
  if (cachedReply !== null) {
    // Twilio retried a delivery we already fully processed (our first response was likely
    // slow or dropped) — replay the same reply instead of re-parsing, re-storing the photo,
    // and re-writing to the Sheet/D1 a second time for one physical receipt.
    return { status: 200, contentType: 'text/xml', body: buildTwiml(cachedReply) };
  }

  let photoR2Key = null;
  if (fields.media.length > 0) {
    photoR2Key = generateReceiptKey(fields.to);
    try {
      await storeReceiptPhoto({
        mediaUrl: fields.media[0].url,
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        imagesBinding: env.IMAGES,
        bucket: env.RECEIPTS_BUCKET,
        key: photoR2Key,
        fetchImpl: deps.fetchImpl,
      });
    } catch (err) {
      console.error('Failed to store receipt photo', { error: err.message });
      return { status: 500, contentType: 'text/plain', body: 'Failed to store photo' };
    }
  }

  try {
    const { smsBody } = await processExpenseMessage({ fields, photoR2Key, env, deps });
    try {
      await cacheReply(env.CONVERSATION_STATE, fields.messageSid, smsBody);
    } catch (err) {
      // Losing dedup protection for one message is far better than failing the whole
      // response over a KV hiccup — log it and still reply normally.
      console.error('Failed to cache reply for dedup', { error: err.message });
    }
    return { status: 200, contentType: 'text/xml', body: buildTwiml(smsBody) };
  } catch (err) {
    console.error('Failed to process expense message', { error: err.message });
    return { status: 500, contentType: 'text/plain', body: 'Failed to process message' };
  }
}

// This route is deliberately public and unauthenticated — the Sheet's Photo column links
// directly to it. Trust relies on the R2 key's embedded UUID being practically unguessable,
// not on any auth check here. Confirmed project-owner decision (see Step 4's Design
// decisions note in the plan) — not an oversight.
export async function handleGetReceipt({ key, bucket }) {
  if (!key.startsWith('receipts/')) {
    return { status: 404, contentType: 'text/plain', body: 'Not found' };
  }
  const object = await bucket.get(key);
  if (!object) {
    return { status: 404, contentType: 'text/plain', body: 'Not found' };
  }
  const bytes = await object.arrayBuffer();
  const contentType = (object.httpMetadata && object.httpMetadata.contentType) || 'image/jpeg';
  return { status: 200, contentType, body: bytes };
}
```

- [x] **Step 4: Update `src/index.js`**

```js
// expense-intake/src/index.js — full replacement
import { handleSmsWebhook, handleGetReceipt } from './handlers.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/sms') {
      const bodyText = await request.text();
      const signature = request.headers.get('X-Twilio-Signature') || '';
      const result = await handleSmsWebhook({ url: request.url, bodyText, signature, env });
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/receipts/')) {
      let key;
      try {
        key = decodeURIComponent(url.pathname.slice('/receipts/'.length));
      } catch {
        return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
      }
      const result = await handleGetReceipt({ key, bucket: env.RECEIPTS_BUCKET });
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      });
    }

    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
```

- [x] **Step 5: Run tests to verify they pass**

Run: `node expense-intake/test/run-all.js`
Expected: all fifteen test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Add `WORKER_BASE_URL` to `wrangler.toml`**

```toml
# expense-intake/wrangler.toml — update the [vars] block (keep AI_PROVIDER, add WORKER_BASE_URL)

[vars]
AI_PROVIDER = "openrouter"
WORKER_BASE_URL = "https://expense-intake.venturesdatasolutions.workers.dev"
```

- [x] **Step 7: Update the README**

```markdown
// expense-intake/README.md — update the "## Routes" section, replace "## Status", and
// add a new section after "## Twilio secrets"

## Routes

- `POST /sms` — Twilio inbound SMS/MMS webhook. Validates `X-Twilio-Signature`,
  stores any attached photo (resized/recompressed, only the first attached
  photo is processed if a message has multiple) to R2, parses/categorizes
  the expense, resolves the client and house, and either files it to that
  house's Google Sheet + the `expenses` table (high confidence, exactly one
  house) or holds it in `pending_review` (low confidence, or an ambiguous
  house) — replying with the appropriate confirmation/low-confidence/
  house-selection SMS copy either way.
- `GET /receipts/:key` — serves a stored receipt photo directly from R2, no
  authentication. Used by the "Photo" column link in each house's Sheet.

## Status

Build Order steps 1-4: repo scaffolding, D1 schema, the provider
abstraction, the Twilio inbound webhook with R2 photo storage, and the full
happy-path pipeline — parse, categorize, file to Sheets/D1 or
`pending_review`, and reply with confirmation copy, with dedup protection
against Twilio's own webhook retries (a repeated delivery of a message
already fully processed replays the cached reply instead of reprocessing).
Not yet built: the interactive house-selection reply flow and 10-minute
correction window (step 5 — right now, an ambiguous-house message is held
in `pending_review` with a prompt, but a client's reply to that prompt
isn't yet matched back to it — step 5 will reuse the same `CONVERSATION_STATE`
KV namespace this step introduced), the `pending` retrieval command
(step 6), Cron Triggers for the daily purge and monthly nudge (step 7),
save-contact onboarding (step 8), and the onboarding CLI script (step 9) —
houses currently need a `google_sheet_id` set via manual SQL before this
pipeline can file to their Sheet.

## KV namespace setup (one-time, per environment)

\`\`\`bash
npx wrangler kv namespace create CONVERSATION_STATE
\`\`\`

Paste the printed `id` into `wrangler.toml`, replacing
`REPLACE_WITH_KV_NAMESPACE_ID`.

## Google service account secret (one-time, per environment)

\`\`\`bash
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
\`\`\`

Paste the **entire contents** of the service account's downloaded JSON key
file (Google Cloud Console → IAM & Admin → Service Accounts → Keys) as a
single value. That service account also needs to be shared as an Editor on
every house's Google Sheet — Sheets created by hand for manual testing
before Build Order step 9's onboarding script exists must be shared with
the service account's `client_email` individually, the same way you'd
share a Sheet with a person.

The confidence threshold that decides "confirmation" vs. "pending review"
is `CONFIDENCE_THRESHOLD` in `src/expense-flow.js` (currently `0.7`) —
tune it after seeing how real receipts parse.
```

- [x] **Step 8: Stage the change**

```bash
git add expense-intake/src/handlers.js expense-intake/src/index.js expense-intake/test/handlers.test.js expense-intake/test/index.test.js expense-intake/wrangler.toml expense-intake/README.md
```

---

## Self-Review — Step 4

**Spec coverage for Step 4:** MESSAGE FLOW step 3 ("Call parseExpense() → vendor, amount, suggested category, confidence") → Task 15's `processExpenseMessage`, which is the only caller of `parseExpense` in this step. MESSAGE FLOW step 5 ("High confidence → write row directly to that house's Google Sheet, send confirmation SMS") → Task 15's confidence-branch writing to `expenses` + Task 12's Sheets append + Task 17's TwiML `<Message>` reply. MESSAGE FLOW step 6 ("Low confidence → write to pending_review only. Never touches the visible Sheet") → Task 15's low-confidence branch, and Task 15's test explicitly asserts no Sheets call happens on that path. GOOGLE SHEETS FORMAT (columns, service account auth, "shared with the client's email as Viewer") → Task 11 (auth), Task 12 (the exact 9-column row order matching Date\|Vendor\|Amount\|Category\|Confidence\|Photo\|Raw Text\|Logged By\|Notes) — sharing the Sheet with the client as Viewer is an onboarding action (Build Order step 9), out of scope for this step, which only writes to an already-shared Sheet. SMS COPY section's `confirmation`/`low_confidence`/`house_selection` copy types (already built in Step 2) → all three are exercised by Task 15's branches. SECRETS section's `GOOGLE_SERVICE_ACCOUNT_JSON` → used for the first time in Task 11, documented in Task 17's README update. Task 16 (message deduplication) isn't derived from the original spec at all — it's a project-owner-confirmed addition in response to a real gap Task 15's code review surfaced (Twilio retry duplication), not a spec requirement, and is called out as such in its own task text.

**Not yet in scope, intentionally (later Build Order steps):** the interactive KV-backed house-selection reply and 10-minute correction window (step 5 — which will reuse the `CONVERSATION_STATE` KV namespace Task 16 introduces, not add a second one), the `pending` retrieval command (step 6), Cron Triggers (step 7), save-contact onboarding (step 8), and the onboarding CLI script (step 9, meaning `houses.google_sheet_id` must currently be set by hand). The Design decisions note above explains why house ambiguity is handled as a `pending_review` write rather than a real interactive prompt in this step.

**Placeholder scan:** No TBD/TODO markers. `WORKER_BASE_URL` uses the real, already-deployed URL (`https://expense-intake.venturesdatasolutions.workers.dev`) confirmed earlier in this project's setup, not a placeholder. `REPLACE_WITH_KV_NAMESPACE_ID` in Task 16's `wrangler.toml` addition is an intentional, documented placeholder (same pattern as Step 1's `REPLACE_WITH_D1_DATABASE_ID` and the original scaffold's KV placeholder note) — the real ID only exists after `wrangler kv namespace create` is run against the actual Cloudflare account, and Task 17's README update spells out that exact command.

**Type consistency:** `processExpenseMessage`'s `{ fields, photoR2Key, env, deps }` parameter shape is used identically by Task 15 itself and by Task 17's `handleSmsWebhook`. `fields` (`{from, to, body, media, messageSid}`) matches `extractWebhookFields`'s output exactly, including the `messageSid` field Task 16 adds to it — `processExpenseMessage` doesn't touch `messageSid` at all (it's only consumed by `handleSmsWebhook`'s dedup check, one layer up), so widening `fields`'s shape didn't require touching Task 15's already-approved code. `env`'s expected keys (`DB`, `RECEIPTS_BUCKET`, `AI_PROVIDER`, `OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `WORKER_BASE_URL`, `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`, `IMAGES`, and now `CONVERSATION_STATE`) are consistent across Task 15's `processExpenseMessage`, Task 17's `handleSmsWebhook`, and `src/index.js`'s real binding wiring — no key is read under one name in one file and a different name elsewhere. `db.js`'s five functions (Task 10) are called with the same parameter names/order everywhere they're used in Task 15. `message-dedup.js`'s `getCachedReply`/`cacheReply` (Task 16) are called with the same `(kv, messageSid, ...)` argument order in both their own tests and Task 17's `handleSmsWebhook`. The `{status, contentType, body}` handler-result shape from Step 3 is preserved unchanged by `handleSmsWebhook`, `handleGetReceipt`, and the new dedup-cache-hit early return.

---

## Step 5: House-selection flow + 10-minute correction window

**Design spec:** `docs/superpowers/specs/2026-08-18-expense-intake-house-selection-correction-design.md` (approved by the project owner). This step closes the two gaps Step 4 deliberately left open: a client's reply to "Which house is this for?" is now actually matched back to the pending item, and a client gets a 10-minute window after any auto-filed expense to correct the house it landed on.

**Interface (from the design spec):** a new shared AI primitive, `matchHouseFromReply({ text, houses }, env, deps) -> { houseId }`, added to the provider abstraction alongside `parseExpense`/`generateSmsCopy`. Two new `CONVERSATION_STATE` KV key prefixes (`awaiting_house:<phone>`, `correction:<phone>`) track in-flight house-selection prompts and open correction windows, both a 10-minute TTL. A new `expenses.sheet_row` column records which Sheet row an expense landed on, so a correction can delete it and re-append to the new house's Sheet.

**Design decisions locked in for this step:**
- `matchHouseFromReply` returns `{ houseId: null }` on no confident match — callers decide what "no match" means in context (re-ask for house-selection, "not a correction, fall through" for the correction window). The function itself has no opinion about which flow is calling it.
- Both `awaiting_house` and `correction` KV state omit `clientId` — by the time either is checked, `processExpenseMessage` has already resolved the client and its house list from the inbound message's own `to`/`from` pair, so the state only needs to carry what it can't otherwise derive (`pendingReviewId`/`attempt` for house-selection; `expenseId`/`houseId`/`spreadsheetId`/`sheetRow` for correction). A smaller state payload than the design spec's earlier draft — the spec anticipated carrying `clientId` on both, which turned out to be redundant once the actual call order in `processExpenseMessage` was worked out during implementation.
- A house-selection match **files the pending item unconditionally** — once the house is known, the guess that was already computed (amount/category/confidence from the original parse) gets written as-is via the same `fileExpense` helper the normal high-confidence path uses. This mirrors the approved design spec's Feature 1 description exactly; the amount/confidence that produced a `pending_review` write in the first place isn't re-evaluated a second time. (A `null` amount is still allowed through — `fileExpense`/`insertExpense` accept a null amount as they already did in Step 4, and the D1 schema has no `NOT NULL` constraint on `expenses.amount`.)
- House-selection re-asks **once**: `attempt: 0 -> 1` on the first no-match, then gives up (clears `awaiting_house`, leaves the item in `pending_review` permanently) on the second. This matches the design spec's "re-ask once, then stay pending" decision.
- A correction only ever changes the house — never amount, category, or vendor. Deleting the old Sheet row assumes the standard single `"Sheet1"` tab at `sheetId` (gid) `0`, the same tab `appendExpenseRow`'s hardcoded `Sheet1!A:I` range already targets; no spreadsheet-metadata lookup is performed to resolve this at runtime, per the design spec.
- `awaiting_house` is checked before `correction` on every inbound message with a non-empty body (checked in that order because an in-flight house-selection prompt should never be silently reinterpreted as a correction reply). A message with an empty body (photo-only) skips both checks entirely — there's no text to match against a house name, so it's always processed as a new expense message, exactly like Step 4's existing empty-body handling for text.
- `insertExpense` and `insertPendingReview` now return the new row's `id` (via D1's `result.meta.last_row_id`), instead of the raw `.run()` result — needed so `fileExpense` can populate `correction` state with the new `expenseId`, and so the ambiguous-house branch can populate `awaiting_house` state with the new `pendingReviewId`. No existing test asserted on either function's return value (both were previously just `await`ed and discarded), so this is a non-breaking extension of already-shipped code, not a redesign.

### Task 18: Provider shared module — `matchHouseFromReply` prompt and result validation

**Files:**
- Modify: `expense-intake/src/providers/shared.js`
- Modify: `expense-intake/test/providers/shared.test.js`

- [x] **Step 1: Write the failing test**

Update the import at the top of `expense-intake/test/providers/shared.test.js`:

```js
import {
  TAX_CATEGORIES,
  PARSE_EXPENSE_SYSTEM_PROMPT,
  SMS_COPY_ANCHORS,
  buildSmsCopyPrompt,
  extractJsonBlock,
  normalizeParseExpenseResult,
  ProviderParseError,
  MATCH_HOUSE_SYSTEM_PROMPT,
  buildMatchHouseUserMessage,
  normalizeMatchHouseResult,
} from '../../src/providers/shared.js';
```

Insert this block into `main()`, immediately before the existing `console.log('PASS: providers/shared.test.js');` line:

```js
  // MATCH_HOUSE_SYSTEM_PROMPT: must instruct JSON-only output with a house_id key
  assert(/house_id/.test(MATCH_HOUSE_SYSTEM_PROMPT), 'match-house prompt must mention house_id');
  assert(/JSON/i.test(MATCH_HOUSE_SYSTEM_PROMPT), 'match-house prompt must instruct JSON-only output');

  // buildMatchHouseUserMessage: lists houses with id/address/nickname, carries the reply text
  const matchHouses = [
    { id: 10, address: '123 Main St', nickname: 'Main St' },
    { id: 11, address: '456 Oak Ave', nickname: null },
  ];
  const matchUserMessage = buildMatchHouseUserMessage('the main st one', matchHouses);
  assert(matchUserMessage.includes('the main st one'), 'user message must carry the reply text verbatim');
  assert(matchUserMessage.includes('id: 10') && matchUserMessage.includes('123 Main St') && matchUserMessage.includes('Main St'), "user message must list the first house's id, address, and nickname");
  assert(matchUserMessage.includes('id: 11') && matchUserMessage.includes('456 Oak Ave'), 'user message must list the second house even without a nickname');

  // normalizeMatchHouseResult: a valid matching house id
  const matchedHouse = normalizeMatchHouseResult({ house_id: 10 }, matchHouses);
  assert(matchedHouse.houseId === 10, 'normalizeMatchHouseResult must pass through a valid house_id');

  // normalizeMatchHouseResult: explicit null means no match
  const noMatchHouse = normalizeMatchHouseResult({ house_id: null }, matchHouses);
  assert(noMatchHouse.houseId === null, 'normalizeMatchHouseResult must allow house_id: null to mean no confident match');

  // normalizeMatchHouseResult: a house_id not in the provided list throws
  let threwUnknownHouse = false;
  try {
    normalizeMatchHouseResult({ house_id: 999 }, matchHouses);
  } catch (err) {
    threwUnknownHouse = true;
    assert(err instanceof ProviderParseError, 'an out-of-list house_id must throw ProviderParseError');
  }
  assert(threwUnknownHouse, 'normalizeMatchHouseResult must reject a house_id that is not one of the provided houses');

  // normalizeMatchHouseResult: a response missing the house_id key throws
  let threwMissingKey = false;
  try {
    normalizeMatchHouseResult({}, matchHouses);
  } catch (err) {
    threwMissingKey = true;
    assert(err instanceof ProviderParseError, 'a response missing house_id must throw ProviderParseError');
  }
  assert(threwMissingKey, 'normalizeMatchHouseResult must reject a response with no house_id key at all');
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/providers/shared.test.js`
Expected: fails — `MATCH_HOUSE_SYSTEM_PROMPT`/`buildMatchHouseUserMessage`/`normalizeMatchHouseResult` are not yet exported from `../../src/providers/shared.js`.

- [x] **Step 3: Add the new exports to the shared module**

Append to `expense-intake/src/providers/shared.js` (after `normalizeParseExpenseResult`):

```js

export const MATCH_HOUSE_SYSTEM_PROMPT = `You are matching a text reply from a real estate investment property client to one of their properties.

Given the client's reply and a list of their properties (each with an id, address, and optional nickname), determine which property the reply refers to, if any. The reply might be a full or partial address, a nickname, a casual description, or something unrelated.

Respond with ONLY a single JSON object with exactly one key, "house_id": either the numeric id of the matching property, or null if the reply does not clearly refer to any of the listed properties. No other text, markdown, or code fences.`;

export function buildMatchHouseUserMessage(text, houses) {
  const houseLines = houses.map((house) => {
    const nicknamePart = house.nickname ? `, nickname: ${house.nickname}` : '';
    return `- id: ${house.id}, address: ${house.address}${nicknamePart}`;
  }).join('\n');
  return `Client reply: "${text}"\n\nProperties:\n${houseLines}`;
}

export function normalizeMatchHouseResult(raw, houses) {
  if (!raw || typeof raw !== 'object' || !('house_id' in raw)) {
    throw new ProviderParseError('Model response for house matching must be a JSON object with a house_id key');
  }
  const { house_id } = raw;
  if (house_id === null) {
    return { houseId: null };
  }
  if (typeof house_id !== 'number' || !houses.some((house) => house.id === house_id)) {
    throw new ProviderParseError(`house_id must be null or one of the provided house ids, got: ${house_id}`);
  }
  return { houseId: house_id };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/providers/shared.test.js`
Expected: `PASS: providers/shared.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change (do not commit yet — held for review)**

```bash
git add expense-intake/src/providers/shared.js expense-intake/test/providers/shared.test.js
```

---

### Task 19: OpenRouter adapter — `openRouterMatchHouseFromReply`

**Files:**
- Modify: `expense-intake/src/providers/openrouter.js`
- Modify: `expense-intake/test/providers/openrouter.test.js`

- [x] **Step 1: Write the failing test**

Update the import at the top of `expense-intake/test/providers/openrouter.test.js`:

```js
import { openRouterParseExpense, openRouterGenerateSmsCopy, openRouterMatchHouseFromReply } from '../../src/providers/openrouter.js';
```

Insert this block into `main()`, immediately before `console.log('PASS: providers/openrouter.test.js');`:

```js
  // matchHouseFromReply: a confident match
  const matchHouses = [
    { id: 10, address: '123 Main St', nickname: 'Main St' },
    { id: 11, address: '456 Oak Ave', nickname: null },
  ];
  const matchFetch = fakeFetch(chatResponse('{"house_id":10}'));
  const matchResult = await openRouterMatchHouseFromReply({ apiKey: 'or_key', text: 'the main st one', houses: matchHouses, fetchImpl: matchFetch });
  assert(matchResult.houseId === 10, 'openRouterMatchHouseFromReply must return the normalized matched house id');
  const matchCall = matchFetch.calls[0];
  assert(matchCall.url === 'https://openrouter.ai/api/v1/chat/completions', 'must hit the OpenRouter chat completions endpoint');
  const matchBody = JSON.parse(matchCall.init.body);
  assert(matchBody.messages[0].role === 'system' && matchBody.messages[0].content.includes('matching a text reply'), 'first message must be the match-house system prompt');
  assert(matchBody.messages[1].content.includes('the main st one'), 'user message must carry the reply text');
  assert(matchBody.temperature === 0, 'house matching must use temperature 0, same as parseExpense, for deterministic matching');

  // matchHouseFromReply: no confident match
  const noMatchFetch = fakeFetch(chatResponse('{"house_id":null}'));
  const noMatchResult = await openRouterMatchHouseFromReply({ apiKey: 'or_key', text: 'what?', houses: matchHouses, fetchImpl: noMatchFetch });
  assert(noMatchResult.houseId === null, 'openRouterMatchHouseFromReply must return houseId: null on no confident match');
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/providers/openrouter.test.js`
Expected: fails — `openRouterMatchHouseFromReply` is not yet exported from `../../src/providers/openrouter.js`.

- [x] **Step 3: Add the adapter function**

Update the import at the top of `expense-intake/src/providers/openrouter.js`:

```js
import { PARSE_EXPENSE_SYSTEM_PROMPT, buildSmsCopyPrompt, extractJsonBlock, normalizeParseExpenseResult, MATCH_HOUSE_SYSTEM_PROMPT, buildMatchHouseUserMessage, normalizeMatchHouseResult } from './shared.js';
```

Append at the bottom of the file:

```js

export async function openRouterMatchHouseFromReply({ apiKey, text, houses, fetchImpl }) {
  const messages = [
    { role: 'system', content: MATCH_HOUSE_SYSTEM_PROMPT },
    { role: 'user', content: buildMatchHouseUserMessage(text, houses) },
  ];
  const content = await openRouterChatCompletion({ apiKey, messages, temperature: 0, fetchImpl });
  return normalizeMatchHouseResult(extractJsonBlock(content), houses);
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/providers/openrouter.test.js`
Expected: `PASS: providers/openrouter.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/providers/openrouter.js expense-intake/test/providers/openrouter.test.js
```

---

### Task 20: Anthropic adapter — `anthropicMatchHouseFromReply`

**Files:**
- Modify: `expense-intake/src/providers/anthropic.js`
- Modify: `expense-intake/test/providers/anthropic.test.js`

- [x] **Step 1: Write the failing test**

Update the import at the top of `expense-intake/test/providers/anthropic.test.js`:

```js
import { anthropicParseExpense, anthropicGenerateSmsCopy, anthropicMatchHouseFromReply } from '../../src/providers/anthropic.js';
```

Insert this block into `main()`, immediately before `console.log('PASS: providers/anthropic.test.js');`:

```js
  // matchHouseFromReply: a confident match
  const matchHouses = [
    { id: 10, address: '123 Main St', nickname: 'Main St' },
    { id: 11, address: '456 Oak Ave', nickname: null },
  ];
  const matchFetch = fakeFetch(messagesResponse('{"house_id":10}'));
  const matchResult = await anthropicMatchHouseFromReply({ apiKey: 'sk-ant-key', text: 'the main st one', houses: matchHouses, fetchImpl: matchFetch });
  assert(matchResult.houseId === 10, 'anthropicMatchHouseFromReply must return the normalized matched house id');
  const matchCall = matchFetch.calls[0];
  assert(matchCall.url === 'https://api.anthropic.com/v1/messages', 'must hit the Anthropic native Messages endpoint');
  const matchBody = JSON.parse(matchCall.init.body);
  assert(matchBody.system.includes('matching a text reply'), 'system field must carry the match-house system prompt');
  assert(matchBody.messages[0].content.includes('the main st one'), 'user message must carry the reply text');
  assert(matchBody.temperature === 0, 'house matching must use temperature 0, same as parseExpense, for deterministic matching');

  // matchHouseFromReply: no confident match
  const noMatchFetch = fakeFetch(messagesResponse('{"house_id":null}'));
  const noMatchResult = await anthropicMatchHouseFromReply({ apiKey: 'sk-ant-key', text: 'what?', houses: matchHouses, fetchImpl: noMatchFetch });
  assert(noMatchResult.houseId === null, 'anthropicMatchHouseFromReply must return houseId: null on no confident match');
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/providers/anthropic.test.js`
Expected: fails — `anthropicMatchHouseFromReply` is not yet exported from `../../src/providers/anthropic.js`.

- [x] **Step 3: Add the adapter function**

Update the import at the top of `expense-intake/src/providers/anthropic.js`:

```js
import { PARSE_EXPENSE_SYSTEM_PROMPT, buildSmsCopyPrompt, extractJsonBlock, normalizeParseExpenseResult, MATCH_HOUSE_SYSTEM_PROMPT, buildMatchHouseUserMessage, normalizeMatchHouseResult } from './shared.js';
```

Append at the bottom of the file:

```js

export async function anthropicMatchHouseFromReply({ apiKey, text, houses, fetchImpl }) {
  const messages = [{ role: 'user', content: buildMatchHouseUserMessage(text, houses) }];
  const content = await anthropicMessagesRequest({ apiKey, system: MATCH_HOUSE_SYSTEM_PROMPT, messages, temperature: 0, fetchImpl });
  return normalizeMatchHouseResult(extractJsonBlock(content), houses);
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/providers/anthropic.test.js`
Expected: `PASS: providers/anthropic.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/providers/anthropic.js expense-intake/test/providers/anthropic.test.js
```

---

### Task 21: Provider selector — `matchHouseFromReply` dispatch

**Files:**
- Modify: `expense-intake/src/providers/index.js`
- Modify: `expense-intake/test/providers/index.test.js`

- [x] **Step 1: Write the failing test**

Update the import at the top of `expense-intake/test/providers/index.test.js`:

```js
import { parseExpense, generateSmsCopy, matchHouseFromReply } from '../../src/providers/index.js';
```

Insert this block into `main()`, immediately before `console.log('PASS: providers/index.test.js');`:

```js
  // matchHouseFromReply routes the same way (default -> OpenRouter)
  const matchHouses = [{ id: 10, address: '123 Main St', nickname: 'Main St' }];
  const matchDefaultFetch = fakeFetch({ choices: [{ message: { content: '{"house_id":10}' } }] });
  const matchDefault = await matchHouseFromReply({ text: 'the main st one', houses: matchHouses }, {
    OPENROUTER_API_KEY: 'or_key', ANTHROPIC_API_KEY: 'ant_key',
  }, { fetchImpl: matchDefaultFetch });
  assert(matchDefaultFetch.calls[0].url === 'https://openrouter.ai/api/v1/chat/completions', 'unset AI_PROVIDER must default matchHouseFromReply to OpenRouter');
  assert(matchDefault.houseId === 10, 'matchHouseFromReply must return the normalized result regardless of provider');

  // matchHouseFromReply routes to Anthropic when AI_PROVIDER=anthropic
  const matchAntFetch = fakeFetch({ content: [{ type: 'text', text: '{"house_id":null}' }] });
  const matchAnt = await matchHouseFromReply({ text: 'huh?', houses: matchHouses }, {
    AI_PROVIDER: 'anthropic', OPENROUTER_API_KEY: 'or_key', ANTHROPIC_API_KEY: 'ant_key',
  }, { fetchImpl: matchAntFetch });
  assert(matchAntFetch.calls[0].url === 'https://api.anthropic.com/v1/messages', 'AI_PROVIDER=anthropic must route matchHouseFromReply to the Anthropic direct adapter');
  assert(matchAnt.houseId === null, 'matchHouseFromReply must return houseId: null on no match regardless of provider');
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/providers/index.test.js`
Expected: fails — `matchHouseFromReply` is not yet exported from `../../src/providers/index.js`.

- [x] **Step 3: Add the selector function**

Replace `expense-intake/src/providers/index.js` in full:

```js
import { openRouterParseExpense, openRouterGenerateSmsCopy, openRouterMatchHouseFromReply } from './openrouter.js';
import { anthropicParseExpense, anthropicGenerateSmsCopy, anthropicMatchHouseFromReply } from './anthropic.js';

export async function parseExpense(input = {}, env, deps = {}) {
  const { text, image } = input;
  const fetchImpl = deps.fetchImpl;
  // Anything other than the exact string 'anthropic' — including unset, or a case/typo mismatch — falls back to openrouter. Intentional per spec; not a bug.
  if (env.AI_PROVIDER === 'anthropic') {
    return anthropicParseExpense({ apiKey: env.ANTHROPIC_API_KEY, text, image, fetchImpl });
  }
  return openRouterParseExpense({ apiKey: env.OPENROUTER_API_KEY, text, image, fetchImpl });
}

export async function generateSmsCopy(type, vars, env, deps = {}) {
  const fetchImpl = deps.fetchImpl;
  // Anything other than the exact string 'anthropic' — including unset, or a case/typo mismatch — falls back to openrouter. Intentional per spec; not a bug.
  if (env.AI_PROVIDER === 'anthropic') {
    return anthropicGenerateSmsCopy({ apiKey: env.ANTHROPIC_API_KEY, type, vars, fetchImpl });
  }
  return openRouterGenerateSmsCopy({ apiKey: env.OPENROUTER_API_KEY, type, vars, fetchImpl });
}

export async function matchHouseFromReply({ text, houses }, env, deps = {}) {
  const fetchImpl = deps.fetchImpl;
  // Same fallback rule as parseExpense/generateSmsCopy above — anything other than the exact string 'anthropic' routes to openrouter.
  if (env.AI_PROVIDER === 'anthropic') {
    return anthropicMatchHouseFromReply({ apiKey: env.ANTHROPIC_API_KEY, text, houses, fetchImpl });
  }
  return openRouterMatchHouseFromReply({ apiKey: env.OPENROUTER_API_KEY, text, houses, fetchImpl });
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/providers/index.test.js`
Expected: `PASS: providers/index.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/providers/index.js expense-intake/test/providers/index.test.js
```

---

### Task 22: D1 migration for `sheet_row` + new query helpers

**Files:**
- Create: `expense-intake/migrations/0002_add_sheet_row.sql`
- Create: `expense-intake/test/migration-0002.test.js`
- Modify: `expense-intake/src/db.js`
- Modify: `expense-intake/test/db.test.js` (full replacement)
- Modify: `expense-intake/test/run-all.js`

- [x] **Step 1: Write the failing tests**

```sql
-- This is what expense-intake/migrations/0002_add_sheet_row.sql must eventually contain —
-- write test/migration-0002.test.js first, per TDD, to check for it before it exists.
```

```js
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
```

Replace `expense-intake/test/db.test.js` in full:

```js
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

  console.log('PASS: db.test.js');
}

await main();
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node expense-intake/test/migration-0002.test.js`
Expected: fails with `Error: migrations/0002_add_sheet_row.sql missing`

Run: `node expense-intake/test/db.test.js`
Expected: fails — `findPendingReviewById`/`deletePendingReview`/`findExpenseById`/`updateExpenseHouse` are not exported yet, and `insertExpense`'s param-count assertion fails against the current 10-param implementation.

- [x] **Step 3: Write the migration and the db.js additions**

```sql
-- expense-intake/migrations/0002_add_sheet_row.sql

ALTER TABLE expenses ADD COLUMN sheet_row INTEGER;
```

Replace `expense-intake/src/db.js` in full:

```js
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
```

- [x] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './migration-0002.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './providers/index.test.js';
import './twilio.test.js';
import './receipt-storage.test.js';
import './db.test.js';
import './google-auth.test.js';
import './sheets.test.js';
import './twiml.test.js';
import './expense-flow.test.js';
import './message-dedup.test.js';
import './conversation-state.test.js';
import './handlers.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

(`./conversation-state.test.js` doesn't exist yet — it's created in Task 24. Adding the import now would break this task's own verification, so leave it out of `run-all.js` until Task 24 and skip straight to `./handlers.test.js` after `./message-dedup.test.js` for now.)

- [x] **Step 5: Run tests to verify they pass**

Run: `node expense-intake/test/run-all.js`
Expected: all test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Validate the migration against real D1 SQLite (local emulation)**

```bash
cd expense-intake
npx wrangler d1 execute expense-intake-db --local --file=migrations/0002_add_sheet_row.sql
npx wrangler d1 execute expense-intake-db --local --command="PRAGMA table_info(expenses)"
```

Expected: no SQL errors; the second command's output includes a `sheet_row` column.

- [x] **Step 7: Stage the change**

```bash
git add expense-intake/migrations/0002_add_sheet_row.sql expense-intake/test/migration-0002.test.js expense-intake/src/db.js expense-intake/test/db.test.js expense-intake/test/run-all.js
```

---

### Task 23: Sheets module — `extractAppendedRowNumber` and `deleteSheetRow`

**Files:**
- Modify: `expense-intake/src/sheets.js`
- Modify: `expense-intake/test/sheets.test.js`

- [x] **Step 1: Write the failing test**

Replace `expense-intake/test/sheets.test.js` in full:

```js
// expense-intake/test/sheets.test.js
import { appendExpenseRow, extractAppendedRowNumber, deleteSheetRow } from '../src/sheets.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function fakeFetch(ok, status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  const okBody = { spreadsheetId: 'sheet123', updates: { updatedRows: 1 } };
  const fetchImpl = fakeFetch(true, 200, okBody);
  const row = ['2026-08-17', 'Home Depot', 42.5, 'Materials', 0.9, 'https://x/receipts/key.jpg', 'HD $42.50', '+15551234567', ''];

  const result = await appendExpenseRow({ accessToken: 'ya29.token', spreadsheetId: 'sheet123', row, fetchImpl });
  assert(result === okBody, 'appendExpenseRow must return the parsed response body');

  const call = fetchImpl.calls[0];
  assert(call.url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/sheet123/values/'), 'must hit the values:append endpoint for the given spreadsheetId');
  assert(call.url.includes(':append'), 'must use the :append action');
  assert(call.url.includes(encodeURIComponent('Sheet1!A:I')), 'must target the Sheet1!A:I range');
  assert(call.url.includes('valueInputOption=USER_ENTERED'), "must use USER_ENTERED so numbers/dates are interpreted, not stored as literal text (required for the Tax Rollup tab's SUM to work)");
  assert(call.url.includes('insertDataOption=INSERT_ROWS'), 'must use INSERT_ROWS so appending never overwrites existing data');
  assert(call.init.headers.Authorization === 'Bearer ya29.token', 'must send the access token as a Bearer token');
  const body = JSON.parse(call.init.body);
  assert(Array.isArray(body.values) && body.values.length === 1 && JSON.stringify(body.values[0]) === JSON.stringify(row), 'must wrap the row in a single-row values array');

  // error path
  const failFetch = fakeFetch(false, 403, { error: { message: 'The caller does not have permission' } });
  let threw = false;
  try {
    await appendExpenseRow({ accessToken: 'bad', spreadsheetId: 'sheet123', row, fetchImpl: failFetch });
  } catch (err) {
    threw = true;
    assert(err.message === 'The caller does not have permission', 'must surface the Sheets API error message');
  }
  assert(threw, 'a non-2xx Sheets API response must throw');

  // extractAppendedRowNumber: parses the row number out of a real append response shape
  const rowNumber = extractAppendedRowNumber({ spreadsheetId: 'sheet123', updates: { updatedRange: 'Sheet1!A5:I5', updatedRows: 1 } });
  assert(rowNumber === 5, 'extractAppendedRowNumber must parse the row number out of updatedRange');

  // extractAppendedRowNumber: a multi-row append parses the starting row
  const multiRowNumber = extractAppendedRowNumber({ updates: { updatedRange: 'Sheet1!A12:I14' } });
  assert(multiRowNumber === 12, 'extractAppendedRowNumber must parse the starting row number for a multi-row range');

  // extractAppendedRowNumber: missing updates.updatedRange throws
  let threwMissingRange = false;
  try {
    extractAppendedRowNumber({ spreadsheetId: 'sheet123' });
  } catch { threwMissingRange = true; }
  assert(threwMissingRange, 'extractAppendedRowNumber must throw when updates.updatedRange is missing');

  // deleteSheetRow
  const deleteFetch = fakeFetch(true, 200, { spreadsheetId: 'sheet123', replies: [{}] });
  await deleteSheetRow({ accessToken: 'ya29.token', spreadsheetId: 'sheet123', sheetRow: 5, fetchImpl: deleteFetch });
  const deleteCall = deleteFetch.calls[0];
  assert(deleteCall.url === 'https://sheets.googleapis.com/v4/spreadsheets/sheet123:batchUpdate', 'deleteSheetRow must hit the batchUpdate endpoint for the given spreadsheetId');
  assert(deleteCall.init.headers.Authorization === 'Bearer ya29.token', 'deleteSheetRow must send the access token as a Bearer token');
  const deleteBody = JSON.parse(deleteCall.init.body);
  const deleteDimension = deleteBody.requests[0].deleteDimension;
  assert(deleteDimension.range.sheetId === 0, 'deleteSheetRow must target the standard Sheet1 tab (gid 0)');
  assert(deleteDimension.range.dimension === 'ROWS', 'deleteSheetRow must delete a row dimension, not columns');
  assert(deleteDimension.range.startIndex === 4 && deleteDimension.range.endIndex === 5, 'deleteSheetRow must convert the 1-indexed sheetRow (5) to the 0-indexed, exclusive-end startIndex/endIndex (4, 5) the batchUpdate API expects');

  // deleteSheetRow: error path
  const deleteFailFetch = fakeFetch(false, 403, { error: { message: 'The caller does not have permission' } });
  let threwDeleteError = false;
  try {
    await deleteSheetRow({ accessToken: 'bad', spreadsheetId: 'sheet123', sheetRow: 5, fetchImpl: deleteFailFetch });
  } catch (err) {
    threwDeleteError = true;
    assert(err.message === 'The caller does not have permission', 'deleteSheetRow must surface the Sheets API error message');
  }
  assert(threwDeleteError, 'a non-2xx batchUpdate response must throw');

  console.log('PASS: sheets.test.js');
}

await main();
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/sheets.test.js`
Expected: fails — `extractAppendedRowNumber`/`deleteSheetRow` are not yet exported from `../src/sheets.js`.

- [x] **Step 3: Write the additions**

Replace `expense-intake/src/sheets.js` in full:

```js
// expense-intake/src/sheets.js
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const APPEND_RANGE = 'Sheet1!A:I'; // fixed tab/column layout — onboarding (not yet built) is expected to create every house's Sheet with this same structure, per Step 4's design note
const DEFAULT_SHEET_ID = 0; // gid of the standard "Sheet1" tab every house's spreadsheet is assumed to use — see Step 5's design spec

export async function appendExpenseRow({ accessToken, spreadsheetId, row, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const range = encodeURIComponent(APPEND_RANGE);
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: [row] }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.error && data.error.message) || `Sheets API request failed with status ${response.status}`;
    throw new Error(message);
  }
  return data;
}

// Parses the 1-indexed row number a row landed on out of an appendExpenseRow response's
// updates.updatedRange (e.g. "Sheet1!A5:I5" -> 5), so it can be targeted for deletion later
// if the client corrects which house an expense belongs to (Step 5).
export function extractAppendedRowNumber(appendResponse) {
  const range = appendResponse && appendResponse.updates && appendResponse.updates.updatedRange;
  if (!range) {
    throw new Error('Sheets append response missing updates.updatedRange');
  }
  const match = range.match(/![A-Z]+(\d+)/);
  if (!match) {
    throw new Error(`Could not parse a row number out of updatedRange: ${range}`);
  }
  return Number(match[1]);
}

export async function deleteSheetRow({ accessToken, spreadsheetId, sheetRow, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: { sheetId: DEFAULT_SHEET_ID, dimension: 'ROWS', startIndex: sheetRow - 1, endIndex: sheetRow },
        },
      }],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.error && data.error.message) || `Sheets API request failed with status ${response.status}`;
    throw new Error(message);
  }
  return data;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/sheets.test.js`
Expected: `PASS: sheets.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/sheets.js expense-intake/test/sheets.test.js
```

---

### Task 24: Conversation-state module — `awaiting_house`/`correction` KV helpers

**Files:**
- Create: `expense-intake/src/conversation-state.js`
- Create: `expense-intake/test/conversation-state.test.js`
- Modify: `expense-intake/test/run-all.js`

- [x] **Step 1: Write the failing test**

```js
// expense-intake/test/conversation-state.test.js
import {
  getAwaitingHouse, setAwaitingHouse, clearAwaitingHouse,
  getCorrectionState, setCorrectionState, clearCorrectionState,
} from '../src/conversation-state.js';
import { createFakeKV } from './fake-kv.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  // awaiting_house: not set
  const kv1 = createFakeKV();
  const missing = await getAwaitingHouse(kv1, '+15551234567');
  assert(missing === null, 'getAwaitingHouse must return null when nothing is stored for this phone');

  // awaiting_house: set then get, with a 10-minute TTL
  const kv2 = createFakeKV();
  await setAwaitingHouse(kv2, '+15551234567', { pendingReviewId: 99, attempt: 0 });
  const putCall = kv2.calls.find((c) => c.method === 'put');
  assert(putCall.key === 'awaiting_house:+15551234567', 'setAwaitingHouse must key by awaiting_house:<phone>');
  assert(putCall.options.expirationTtl === 600, 'setAwaitingHouse must use a 10-minute (600s) TTL');
  const state = await getAwaitingHouse(kv2, '+15551234567');
  assert(state.pendingReviewId === 99 && state.attempt === 0, 'getAwaitingHouse must return the exact stored state, JSON round-tripped');

  // awaiting_house: clear
  const kv3 = createFakeKV();
  await setAwaitingHouse(kv3, '+15551234567', { pendingReviewId: 1, attempt: 0 });
  await clearAwaitingHouse(kv3, '+15551234567');
  assert((await getAwaitingHouse(kv3, '+15551234567')) === null, 'clearAwaitingHouse must delete the stored state');

  // correction: not set
  const kv4 = createFakeKV();
  const missingCorrection = await getCorrectionState(kv4, '+15551234567');
  assert(missingCorrection === null, 'getCorrectionState must return null when nothing is stored for this phone');

  // correction: set then get, with a 10-minute TTL
  const kv5 = createFakeKV();
  await setCorrectionState(kv5, '+15551234567', { expenseId: 42, houseId: 10, spreadsheetId: 'sheet_abc', sheetRow: 5 });
  const correctionPutCall = kv5.calls.find((c) => c.method === 'put');
  assert(correctionPutCall.key === 'correction:+15551234567', 'setCorrectionState must key by correction:<phone>');
  assert(correctionPutCall.options.expirationTtl === 600, 'setCorrectionState must use a 10-minute (600s) TTL');
  const correctionState = await getCorrectionState(kv5, '+15551234567');
  assert(correctionState.expenseId === 42 && correctionState.sheetRow === 5, 'getCorrectionState must return the exact stored state, JSON round-tripped');

  // correction: setting again for the same phone overwrites the previous state (the
  // "always the most recent filed expense" rule from the design spec)
  const kv6 = createFakeKV();
  await setCorrectionState(kv6, '+15551234567', { expenseId: 1, houseId: 10, spreadsheetId: 'sheet_abc', sheetRow: 5 });
  await setCorrectionState(kv6, '+15551234567', { expenseId: 2, houseId: 10, spreadsheetId: 'sheet_abc', sheetRow: 6 });
  const latest = await getCorrectionState(kv6, '+15551234567');
  assert(latest.expenseId === 2, 'a second setCorrectionState call for the same phone must overwrite the first');

  // correction: clear
  const kv7 = createFakeKV();
  await setCorrectionState(kv7, '+15551234567', { expenseId: 1, houseId: 10, spreadsheetId: 'sheet_abc', sheetRow: 5 });
  await clearCorrectionState(kv7, '+15551234567');
  assert((await getCorrectionState(kv7, '+15551234567')) === null, 'clearCorrectionState must delete the stored state');

  console.log('PASS: conversation-state.test.js');
}

await main();
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/conversation-state.test.js`
Expected: fails with a module-not-found error for `../src/conversation-state.js` (it doesn't exist yet).

- [x] **Step 3: Write the module**

```js
// expense-intake/src/conversation-state.js
// House-selection and correction-window state, both scoped by sender phone number and both
// a 10-minute TTL — see Step 5's design spec
// (docs/superpowers/specs/2026-08-18-expense-intake-house-selection-correction-design.md).
// Shares the CONVERSATION_STATE KV namespace Step 4's message-dedup.js already introduced,
// under different key prefixes, rather than a second namespace.
const STATE_TTL_SECONDS = 10 * 60;

export async function getAwaitingHouse(kv, phone) {
  const value = await kv.get(`awaiting_house:${phone}`, { type: 'json' });
  return value ?? null;
}

export async function setAwaitingHouse(kv, phone, state) {
  await kv.put(`awaiting_house:${phone}`, JSON.stringify(state), { expirationTtl: STATE_TTL_SECONDS });
}

export async function clearAwaitingHouse(kv, phone) {
  await kv.delete(`awaiting_house:${phone}`);
}

export async function getCorrectionState(kv, phone) {
  const value = await kv.get(`correction:${phone}`, { type: 'json' });
  return value ?? null;
}

export async function setCorrectionState(kv, phone, state) {
  await kv.put(`correction:${phone}`, JSON.stringify(state), { expirationTtl: STATE_TTL_SECONDS });
}

export async function clearCorrectionState(kv, phone) {
  await kv.delete(`correction:${phone}`);
}
```

- [x] **Step 4: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './migration-0002.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './providers/index.test.js';
import './twilio.test.js';
import './receipt-storage.test.js';
import './db.test.js';
import './google-auth.test.js';
import './sheets.test.js';
import './twiml.test.js';
import './expense-flow.test.js';
import './message-dedup.test.js';
import './conversation-state.test.js';
import './handlers.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 5: Run tests to verify they pass**

Run: `node expense-intake/test/run-all.js`
Expected: all test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/conversation-state.js expense-intake/test/conversation-state.test.js expense-intake/test/run-all.js
```

---

### Task 25: New SMS copy anchors — retry, give-up, correction-confirmed

**Files:**
- Modify: `expense-intake/src/providers/shared.js`
- Modify: `expense-intake/test/providers/shared.test.js`

- [x] **Step 1: Write the failing test**

Insert this block into `main()` of `expense-intake/test/providers/shared.test.js`, immediately after the existing `SMS_COPY_ANCHORS.monthly_nudge` assertion and before the `buildSmsCopyPrompt` section:

```js
  assert(SMS_COPY_ANCHORS.house_selection_retry.length === 2, 'house_selection_retry must have 2 tone anchors');
  assert(SMS_COPY_ANCHORS.house_selection_giveup.length === 2, 'house_selection_giveup must have 2 tone anchors');
  assert(SMS_COPY_ANCHORS.correction_confirmed.length === 2, 'correction_confirmed must have 2 tone anchors');
```

Insert this block into `main()`, immediately before the Task 18 additions (i.e. right before `console.log('PASS: providers/shared.test.js');`):

```js
  // buildSmsCopyPrompt must work for each of the three new Step 5 types too (reuses the
  // same generic machinery already exercised above for confirmation/house_selection/etc.)
  const retryPrompt = buildSmsCopyPrompt('house_selection_retry', { house_list: '123 Main St or the Duplex' });
  assert(retryPrompt.user.includes('house_list: 123 Main St or the Duplex'), 'house_selection_retry prompt must carry the actual house list value');
  const giveupPrompt = buildSmsCopyPrompt('house_selection_giveup', {});
  assert(giveupPrompt.system.includes('saved'), 'house_selection_giveup prompt must include its tone anchors');
  const correctionPrompt = buildSmsCopyPrompt('correction_confirmed', { house: '456 Oak Ave' });
  assert(correctionPrompt.user.includes('house: 456 Oak Ave'), 'correction_confirmed prompt must carry the actual house value');
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/providers/shared.test.js`
Expected: fails — `SMS_COPY_ANCHORS.house_selection_retry` (and the other two) are `undefined`.

- [x] **Step 3: Add the new anchors**

In `expense-intake/src/providers/shared.js`, add three keys to `SMS_COPY_ANCHORS`, immediately after `monthly_nudge`:

```js
  house_selection_retry: [
    "Sorry, didn't catch that — is this for [house_list]?",
    'Just to confirm, which one is it: [house_list]?',
  ],
  house_selection_giveup: [
    'No worries — saved this one for you to sort out later.',
    'Got it, saved for manual review — no rush.',
  ],
  correction_confirmed: [
    'Updated — moved to [house]. Thanks for the heads up.',
    'Fixed, now logged under [house].',
  ],
```

(`buildSmsCopyPrompt` already handles any type present in `SMS_COPY_ANCHORS` generically — no other code change is needed for these three new types to work.)

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/providers/shared.test.js`
Expected: `PASS: providers/shared.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/providers/shared.js expense-intake/test/providers/shared.test.js
```

---

### Task 26: `fileExpense` extraction + house-selection resolution + correction-window wiring

**Files:**
- Modify: `expense-intake/src/expense-flow.js` (full replacement)
- Modify: `expense-intake/test/expense-flow.test.js` (full replacement)

This is the integration task: it extracts the `fileExpense` helper (used by both the normal auto-file path and Feature 1's house-selection resolution), and wires the `awaiting_house`/`correction` checks into `processExpenseMessage`'s routing order, per the Design decisions above.

- [x] **Step 1: Write the failing tests**

Replace `expense-intake/test/expense-flow.test.js` in full:

```js
// expense-intake/test/expense-flow.test.js
import crypto from 'node:crypto';
import { processExpenseMessage } from '../src/expense-flow.js';
import { createFakeD1 } from './fake-d1.js';
import { createFakeR2Bucket } from './fake-r2.js';
import { createFakeKV } from './fake-kv.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function generateTestServiceAccount() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { client_email: 'test-sa@test.iam.gserviceaccount.com', private_key: privateKey };
}

function chatResponse(content) {
  return { choices: [{ message: { content } }] };
}

function dispatchFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    for (const [match, respond] of handlers) {
      if (url.includes(match)) return respond(url, init);
    }
    throw new Error(`Unhandled fetch in test: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function jsonOk(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

async function withStoredPhoto(bucket, key) {
  await bucket.put(key, new ArrayBuffer(4), { httpMetadata: { contentType: 'image/jpeg' } });
}

function baseEnv(db, bucket, overrides = {}) {
  return {
    DB: db,
    RECEIPTS_BUCKET: bucket,
    CONVERSATION_STATE: createFakeKV(),
    AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'or_key',
    GOOGLE_SERVICE_ACCOUNT_JSON: generateTestServiceAccount(),
    WORKER_BASE_URL: 'https://expense-intake.example.workers.dev',
    ...overrides,
  };
}

function openRouterHandler(parseContent, copyContent) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const isParse = body.messages.some((m) => Array.isArray(m.content));
    const content = isParse ? parseContent : copyContent;
    return { ok: true, status: 200, json: async () => chatResponse(content) };
  };
}

// Distinguishes OpenRouter calls by the actual system prompt text (all three of
// parseExpense/matchHouseFromReply/generateSmsCopy send a plain-string system prompt, so
// they can be told apart even though matchHouseFromReply and generateSmsCopy calls otherwise
// look identical in shape). Used only by the Step 5 scenarios below, which exercise more
// than two of these call types in a single test.
function openRouterRouter({ parse, match, copy }) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    let content = copy;
    if (typeof system === 'string' && system.includes('expense-parsing assistant')) content = parse;
    else if (typeof system === 'string' && system.includes('matching a text reply')) content = match;
    return { ok: true, status: 200, json: async () => chatResponse(content) };
  };
}

async function main() {
  const client = { id: 1, twilio_number: '+15559876543' };
  const sender = { id: 5, client_id: 1, phone_number: '+15551234567' };
  const singleHouse = [{ id: 10, client_id: 1, address: '123 Main St', nickname: 'Main St', google_sheet_id: 'sheet_abc' }];

  // 1. Happy path: single house, high confidence, photo message
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    await withStoredPhoto(bucket, 'receipts/x/1.jpg');
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.9, raw_text: 'HD $42.50' }),
        'Logged: $42.50, Materials, Main St.'
      )],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: '', media: [] },
      photoR2Key: 'receipts/x/1.jpg',
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a high-confidence happy path must produce a confirmation SMS body');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert, 'a high-confidence match must insert an expenses row');
    assert(expenseInsert.params[4] === 'Materials', 'the inserted expense must carry the parsed category');
    const sheetsCall = fetchImpl.calls.find((c) => c.url.includes('sheets.googleapis.com'));
    assert(sheetsCall, 'a high-confidence match must append a row to the house Sheet');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(!pendingInsert, 'a high-confidence match must not also write to pending_review');
  }

  // 2. Low confidence: single house, low-confidence parse -> pending_review, not expenses
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: null, amount: null, category: 'Other', confidence: 0.2, raw_text: 'blurry' }),
        'Saved under Other — flagged for review.'
      )],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'some note', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a low-confidence match must still produce an SMS body');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'a low-confidence match must write to pending_review');
    assert(pendingInsert.params[1] === 10, 'a low-confidence match with a known house must still record that house_id in pending_review');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(!expenseInsert, 'a low-confidence match must not write to expenses');
    const sheetsCall = fetchImpl.calls.find((c) => c.url.includes('sheets.googleapis.com'));
    assert(!sheetsCall, 'a low-confidence match must not touch the Sheet');
  }

  // 2b. High confidence but null amount: single house, high-confidence parse with an unknown
  // amount -> pending_review, not expenses (a confident category/vendor doesn't make an
  // unreadable total safe to auto-file as $0.00)
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'Home Depot', amount: null, category: 'Materials', confidence: 0.9, raw_text: 'torn receipt' }),
        'Saved under Materials — flagged for review.'
      )],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'torn receipt', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a high-confidence match with a null amount must still produce an SMS body');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'a high-confidence match with a null amount must fall through to pending_review');
    assert(pendingInsert.params[1] === 10, 'a high-confidence match with a null amount and a known house must still record that house_id in pending_review');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(!expenseInsert, 'a high-confidence match with a null amount must not write to expenses');
    const sheetsCall = fetchImpl.calls.find((c) => c.url.includes('sheets.googleapis.com'));
    assert(!sheetsCall, 'a high-confidence match with a null amount must not touch the Sheet');
  }

  // 3. Ambiguous house (two houses): pending_review with house_id null, house_selection copy
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'Lowes', amount: 10, category: 'Materials', confidence: 0.95, raw_text: 'Lowes $10' }),
        'Which house is this for?'
      )],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'Lowes $10', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'an ambiguous house must still produce a prompt SMS body');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'an ambiguous house must write to pending_review even with high confidence');
    assert(pendingInsert.params[1] === null, "an ambiguous house must record a null house_id, since we don't know which one");
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(!expenseInsert, 'an ambiguous house must never write directly to expenses, regardless of confidence');
  }

  // 4. Unknown client: silent ack, no writes
  {
    const db = createFakeD1({ 'SELECT * FROM clients WHERE twilio_number = ?': null });
    const bucket = createFakeR2Bucket();
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+10000000000', body: 'hi', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: {},
    });
    assert(result.smsBody === '', 'an unrecognized Twilio "To" number must produce a silent (empty) acknowledgment');
    assert(db.calls.length === 1, 'an unknown client must not proceed past the initial client lookup');
  }

  // 5. Unauthorized sender: silent ack
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': null,
    });
    const bucket = createFakeR2Bucket();
    const result = await processExpenseMessage({
      fields: { from: '+19998887777', to: '+15559876543', body: 'hi', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: {},
    });
    assert(result.smsBody === '', 'an unauthorized sender must produce a silent (empty) acknowledgment');
  }

  // 6. Empty message (no body, no photo): silent ack, no D1 lookups at all
  {
    const db = createFakeD1();
    const bucket = createFakeR2Bucket();
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: '', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: {},
    });
    assert(result.smsBody === '', 'a genuinely empty message must produce a silent acknowledgment');
    assert(db.calls.length === 0, 'a genuinely empty message must short-circuit before any D1 lookups');
  }

  // 7. Parse failure: treated as confidence 0, routed to pending_review
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', async (url, init) => {
        const body = JSON.parse(init.body);
        const isParse = body.messages.some((m) => Array.isArray(m.content));
        if (isParse) {
          return { ok: false, status: 500, json: async () => ({ error: { message: 'upstream error' } }) };
        }
        return { ok: true, status: 200, json: async () => chatResponse('Saved under Uncategorized — flagged for review.') };
      }],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'something', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a parse failure must still produce a low-confidence-style SMS body, not crash the whole message');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'a parse failure must fall back to pending_review');
    assert(pendingInsert.params[6] === 0, 'a parse failure must record confidence 0, not a fabricated value');
  }

  // 8. Missing google_sheet_id on the resolved house: throws (a config gap, not silently swallowed)
  {
    const houseWithoutSheet = [{ id: 12, client_id: 1, address: '789 Pine Rd', nickname: null, google_sheet_id: null }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': houseWithoutSheet,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'X', amount: 1, category: 'Other', confidence: 0.99, raw_text: 'X $1' }),
        'unused'
      )],
    ]);
    let threw = false;
    try {
      await processExpenseMessage({
        fields: { from: '+15551234567', to: '+15559876543', body: 'X $1', media: [] },
        photoR2Key: null,
        env: baseEnv(db, bucket),
        deps: { fetchImpl },
      });
    } catch (err) {
      threw = true;
      assert(/google_sheet_id/.test(err.message), 'the error must clearly identify the missing google_sheet_id, not fail with a generic message');
    }
    assert(threw, 'a house with no Sheet configured must throw rather than silently losing a would-be-filed expense');
  }

  // 9. generateSmsCopy fails AFTER the write already succeeded (high confidence): the
  // pipeline must still complete with fallback copy, not throw.
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', async (url, init) => {
        const body = JSON.parse(init.body);
        const isParse = body.messages.some((m) => Array.isArray(m.content));
        if (isParse) {
          return { ok: true, status: 200, json: async () => chatResponse(JSON.stringify({ vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.9, raw_text: 'HD $42.50' })) };
        }
        return { ok: false, status: 500, json: async () => ({ error: { message: 'upstream error' } }) };
      }],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'HD $42.50', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody === 'Logged: $42.50, Materials, Main St.', 'a generateSmsCopy failure after a successful write must fall back to static confirmation copy with the real values substituted, not throw');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert, 'the write must have already succeeded before the copy-generation failure');
  }

  // 10. generateSmsCopy fails on the ambiguous-house (house_selection) path: must still
  // fall back to static copy, and the pending_review write (house_id null) must have
  // already happened.
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', async (url, init) => {
        const body = JSON.parse(init.body);
        const isParse = body.messages.some((m) => Array.isArray(m.content));
        if (isParse) {
          return { ok: true, status: 200, json: async () => chatResponse(JSON.stringify({ vendor: 'Lowes', amount: 10, category: 'Materials', confidence: 0.95, raw_text: 'Lowes $10' })) };
        }
        return { ok: false, status: 500, json: async () => ({ error: { message: 'upstream error' } }) };
      }],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'Lowes $10', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody === 'Which house is this for? Address or nickname works.', 'a generateSmsCopy failure on the ambiguous-house path must fall back to static house_selection copy, not throw');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'the pending_review write must have already succeeded before the copy-generation failure');
    assert(pendingInsert.params[1] === null, 'the ambiguous-house pending_review write must still record a null house_id');
  }

  // 11. generateSmsCopy fails on the low-confidence path: must still fall back to static
  // copy with the real category substituted, and the pending_review write must have already
  // happened.
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', async (url, init) => {
        const body = JSON.parse(init.body);
        const isParse = body.messages.some((m) => Array.isArray(m.content));
        if (isParse) {
          return { ok: true, status: 200, json: async () => chatResponse(JSON.stringify({ vendor: null, amount: null, category: 'Other', confidence: 0.2, raw_text: 'blurry' })) };
        }
        return { ok: false, status: 500, json: async () => ({ error: { message: 'upstream error' } }) };
      }],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'some note', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody === "Logged this as Other but wasn't fully sure — flagged it for you to double check.", 'a generateSmsCopy failure on the low-confidence path must fall back to static low_confidence copy with the real category substituted, not throw');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'the pending_review write must have already succeeded before the copy-generation failure');
  }

  // 12. Ambiguous house also opens an awaiting_house KV window (Step 5, Feature 1 setup)
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'Lowes', amount: 10, category: 'Materials', confidence: 0.95, raw_text: 'Lowes $10' }),
        'Which house is this for?'
      )],
    ]);
    await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'Lowes $10', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    const state = await kv.get('awaiting_house:+15551234567', { type: 'json' });
    assert(state && state.pendingReviewId === 1 && state.attempt === 0, 'an ambiguous house must open an awaiting_house KV window pointing at the new pending_review row, attempt 0');
  }

  // 13. A house-selection reply that matches resolves the pending item: files the expense
  // (Sheet + expenses), deletes the pending_review row, clears awaiting_house, and opens a
  // correction window for the newly-filed expense.
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const pendingRow = { id: 77, client_id: 1, house_id: null, amount_guess: 10, category_guess: 'Materials', photo_r2_key: null, raw_text: 'Lowes $10', confidence: 0.95 };
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
      'SELECT * FROM pending_review WHERE id = ?': pendingRow,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'awaiting_house:+15551234567': JSON.stringify({ pendingReviewId: 77, attempt: 0 }) });
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterRouter({ match: '{"house_id":11}', copy: 'Logged: $10.00, Materials, 456 Oak Ave.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: '456 Oak', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a resolved house-selection reply must produce a confirmation SMS body');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert && expenseInsert.params[0] === 11, 'the resolved pending item must be filed under the matched house');
    const pendingDelete = db.calls.find((c) => c.sql.includes('DELETE FROM pending_review'));
    assert(pendingDelete && pendingDelete.params[0] === 77, 'the resolved pending_review row must be deleted');
    assert((await kv.get('awaiting_house:+15551234567')) === null, 'awaiting_house state must be cleared once resolved');
    const correctionState = await kv.get('correction:+15551234567', { type: 'json' });
    assert(correctionState && correctionState.houseId === 11, 'resolving a house-selection reply must open a correction window for the newly-filed expense');
  }

  // 14. A house-selection reply that doesn't match, on the first attempt, re-asks with the
  // house list spelled out and bumps attempt to 1 — no file, no delete.
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'awaiting_house:+15551234567': JSON.stringify({ pendingReviewId: 77, attempt: 0 }) });
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterRouter({ match: '{"house_id":null}', copy: 'Sorry, is this for Main St or 456 Oak Ave?' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'not sure', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a first no-match must still produce a re-ask SMS body');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(!expenseInsert, 'a first no-match must not file anything');
    const state = await kv.get('awaiting_house:+15551234567', { type: 'json' });
    assert(state && state.attempt === 1 && state.pendingReviewId === 77, 'a first no-match must bump attempt to 1 and keep the same pendingReviewId');
  }

  // 15. A house-selection reply that doesn't match a second time gives up: clears
  // awaiting_house, leaves the item in pending_review permanently (no delete call).
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'awaiting_house:+15551234567': JSON.stringify({ pendingReviewId: 77, attempt: 1 }) });
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterRouter({ match: '{"house_id":null}', copy: 'No worries, saved for review.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'still not sure', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a second no-match must still produce a give-up SMS body');
    const pendingDelete = db.calls.find((c) => c.sql.includes('DELETE FROM pending_review'));
    assert(!pendingDelete, 'a second no-match must leave the pending_review row in place for manual resolution');
    assert((await kv.get('awaiting_house:+15551234567')) === null, 'a second no-match must clear awaiting_house so the client is not stuck being re-prompted forever');
  }

  // 16. A correction-window reply that matches a different house moves the expense: deletes
  // the old Sheet row, appends to the new house's Sheet, updates expenses.house_id/sheet_row,
  // and clears the correction window.
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const filedExpense = {
      id: 42, house_id: 10, date: '2026-08-17', vendor: 'Home Depot', amount: 42.5, category: 'Materials',
      confidence: 0.9, photo_r2_key: null, raw_text: 'HD $42.50', logged_by_phone: '+15551234567', notes: '', sheet_row: 5,
    };
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
      'SELECT * FROM expenses WHERE id = ?': filedExpense,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'correction:+15551234567': JSON.stringify({ expenseId: 42, houseId: 10, spreadsheetId: 'sheet_abc', sheetRow: 5 }) });
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', async (url, init) => {
        if (url.includes(':batchUpdate')) return { ok: true, status: 200, json: async () => ({ replies: [{}] }) };
        return { ok: true, status: 200, json: async () => ({ updates: { updatedRange: 'Sheet1!A2:I2' } }) };
      }],
      ['openrouter.ai', openRouterRouter({ match: '{"house_id":11}', copy: 'Updated — moved to 456 Oak Ave.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'wrong house, it was 456 Oak', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a matched correction must produce a confirmation SMS body');
    const deleteCall = fetchImpl.calls.find((c) => c.url.includes(':batchUpdate'));
    assert(deleteCall, 'a matched correction must delete the old Sheet row via batchUpdate');
    const appendCall = fetchImpl.calls.find((c) => c.url.includes(':append'));
    assert(appendCall, "a matched correction must append a new row to the new house's Sheet");
    assert(appendCall.url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/sheet_def/'), 'the new row must be appended to the matched house\'s spreadsheet, not the original one');
    const houseUpdate = db.calls.find((c) => c.sql.includes('UPDATE expenses SET house_id'));
    assert(houseUpdate && JSON.stringify(houseUpdate.params) === JSON.stringify([11, 2, 42]), 'the expense row must be updated to the new house_id and new sheet_row');
    assert((await kv.get('correction:+15551234567')) === null, 'a successful correction must clear the correction window — one correction per filed expense');
  }

  // 17. A correction-window reply that doesn't match any house is not a correction at all —
  // it falls through and gets processed as a brand-new expense message, and the correction
  // window ends up re-set to point at that new expense (fileExpense always opens a fresh
  // correction window on every successful file, per the Design decisions above).
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'correction:+15551234567': JSON.stringify({ expenseId: 42, houseId: 10, spreadsheetId: 'sheet_abc', sheetRow: 5 }) });
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ updates: { updatedRange: 'Sheet1!A3:I3' } })],
      ['openrouter.ai', openRouterRouter({ match: '{"house_id":null}', parse: JSON.stringify({ vendor: 'Lowes', amount: 8, category: 'Materials', confidence: 0.9, raw_text: 'Lowes $8' }), copy: 'Logged: $8.00, Materials, Main St.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'Lowes $8 for screws', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a non-matching correction-window reply must still produce a normal SMS body from the fallthrough processing');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert, 'a non-matching correction-window reply must be processed as a new expense (high confidence, single house)');
    const correctionState = await kv.get('correction:+15551234567', { type: 'json' });
    assert(correctionState && correctionState.expenseId === 1, 'the correction window must be overwritten to point at the newly-filed expense, not left stale pointing at the old one');
  }

  console.log('PASS: expense-flow.test.js');
}

await main();
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node expense-intake/test/expense-flow.test.js`
Expected: fails — `matchHouseFromReply` isn't imported/used by the current `expense-flow.js`, so scenarios 12-17 don't behave as asserted (e.g. no `awaiting_house` KV writes happen at all yet), and scenario 1 now needs `env.CONVERSATION_STATE` which the current `fileExpense`-less implementation never reads but the test's `baseEnv` now always provides — the failures will show up as the new scenario 12-17 assertions failing, not a crash.

- [x] **Step 3: Rewrite `src/expense-flow.js`**

Replace `expense-intake/src/expense-flow.js` in full:

```js
// expense-intake/src/expense-flow.js
import { parseExpense, generateSmsCopy, matchHouseFromReply } from './providers/index.js';
import {
  findClientByTwilioNumber, findAuthorizedSender, findHousesForClient,
  insertExpense, insertPendingReview, findPendingReviewById, deletePendingReview,
  findExpenseById, updateExpenseHouse,
} from './db.js';
import { getGoogleAccessToken } from './google-auth.js';
import { appendExpenseRow, extractAppendedRowNumber, deleteSheetRow } from './sheets.js';
import {
  getAwaitingHouse, setAwaitingHouse, clearAwaitingHouse,
  getCorrectionState, setCorrectionState, clearCorrectionState,
} from './conversation-state.js';

const CONFIDENCE_THRESHOLD = 0.7; // tunable — see Step 4's Design decisions note in the plan
const PENDING_REVIEW_TTL_DAYS = 60; // matches spec's 60-day auto-purge (Cron Trigger is Build Order step 7)

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function pendingReviewExpiresAt() {
  return new Date(Date.now() + PENDING_REVIEW_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function receiptPhotoUrl(baseUrl, photoR2Key) {
  return `${baseUrl}/receipts/${encodeURIComponent(photoR2Key)}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function loadStoredPhotoAsImageInput(bucket, photoR2Key) {
  const object = await bucket.get(photoR2Key);
  if (!object) {
    throw new Error(`Stored receipt photo not found in R2: ${photoR2Key}`);
  }
  const bytes = await object.arrayBuffer();
  return { base64: arrayBufferToBase64(bytes), mediaType: 'image/jpeg' };
}

function houseLabel(house) {
  return house.nickname || house.address;
}

// Static fallback copy, used only if the AI copy-generation call itself fails. Deliberately
// NOT the raw SMS_COPY_ANCHORS strings from providers/shared.js (Step 2) — those contain
// literal bracket placeholders like "[amount]" meant only as few-shot prompt examples, never
// meant to be sent to a client verbatim. These fallbacks substitute the real values instead.
const FALLBACK_SMS_COPY = {
  confirmation: (vars) => `Logged: $${vars.amount}, ${vars.category}, ${vars.house}.`,
  low_confidence: (vars) => `Logged this as ${vars.category} but wasn't fully sure — flagged it for you to double check.`,
  house_selection: () => 'Which house is this for? Address or nickname works.',
  house_selection_retry: (vars) => `Sorry, could you confirm — is this for ${vars.house_list}?`,
  house_selection_giveup: () => 'No worries — saved this one for you to sort out later.',
  correction_confirmed: (vars) => `Updated — moved to ${vars.house}.`,
};

// A copy-generation failure must never re-trigger writes that already succeeded. By the
// time this is called, the relevant write has already committed — if generateSmsCopy then
// throws (rate limit, timeout, network blip, all realistic for an external API call) and
// that exception were allowed to propagate, handleSmsWebhook's outer catch would turn it
// into a 500, Twilio would retry the whole webhook, and — since nothing gets cached on a 500
// (Task 16) — the retry would reprocess from scratch. Falling back to static copy instead
// means the pipeline always finishes, gets cached, and Twilio never retries a message whose
// writes already succeeded.
async function safeGenerateSmsCopy(type, vars, env, deps) {
  try {
    return await generateSmsCopy(type, vars, env, deps);
  } catch (err) {
    console.error('generateSmsCopy failed, using fallback copy', { error: err.message, type });
    // Defensive: FALLBACK_SMS_COPY only covers the types this module currently calls with.
    // If a future call site invokes this with a type that hasn't been given a fallback
    // entry, FALLBACK_SMS_COPY[type] is undefined — calling it would throw a TypeError from
    // inside this catch block itself. A generic last-resort string keeps the guarantee
    // unconditional.
    const fallback = FALLBACK_SMS_COPY[type];
    return fallback ? fallback(vars) : 'We logged this — reply if something looks off.';
  }
}

// Writes an already-parsed, already-house-resolved expense to the house's Sheet + the
// expenses table, and opens the 10-minute correction window for it. Shared by the normal
// high-confidence auto-file path and by a house-selection reply that resolves a pending
// item (Step 5) — both need the exact same write sequence.
async function fileExpense({ house, parsed, fields, photoR2Key, env, deps }) {
  if (!house.google_sheet_id) {
    // A house with no Sheet set up is an onboarding gap, not a runtime parsing issue —
    // surface it loudly (visible in wrangler tail) rather than silently losing the expense
    // into pending_review, which would mask a real setup bug during manual (pre-step-9) onboarding.
    throw new Error(`House ${house.id} has no google_sheet_id configured`);
  }
  const accessToken = await getGoogleAccessToken({ serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON, fetchImpl: deps.fetchImpl });
  const photoUrl = photoR2Key ? receiptPhotoUrl(env.WORKER_BASE_URL, photoR2Key) : '';
  const appendResponse = await appendExpenseRow({
    accessToken,
    spreadsheetId: house.google_sheet_id,
    row: [todayIso(), parsed.vendor, parsed.amount, parsed.category, parsed.confidence, photoUrl, parsed.raw_text, fields.from, ''],
    fetchImpl: deps.fetchImpl,
  });
  const sheetRow = extractAppendedRowNumber(appendResponse);
  const expenseId = await insertExpense(env.DB, {
    houseId: house.id,
    date: todayIso(),
    vendor: parsed.vendor,
    amount: parsed.amount,
    category: parsed.category,
    confidence: parsed.confidence,
    photoR2Key,
    rawText: parsed.raw_text,
    loggedByPhone: fields.from,
    notes: '',
    sheetRow,
  });
  await setCorrectionState(env.CONVERSATION_STATE, fields.from, {
    expenseId,
    houseId: house.id,
    spreadsheetId: house.google_sheet_id,
    sheetRow,
  });
  return safeGenerateSmsCopy('confirmation', {
    amount: parsed.amount != null ? parsed.amount.toFixed(2) : '0.00',
    category: parsed.category,
    house: houseLabel(house),
  }, env, deps);
}

// Resolves an in-flight house-selection prompt (Step 5, Feature 1). Always returns a
// non-null SMS body — every branch here (match, retry, give-up) produces a reply.
async function handleAwaitingHouseReply({ state, houses, fields, env, deps }) {
  const { houseId } = await matchHouseFromReply({ text: fields.body, houses }, env, deps);

  if (houseId != null) {
    const house = houses.find((h) => h.id === houseId);
    const pending = await findPendingReviewById(env.DB, state.pendingReviewId);
    const parsed = {
      vendor: null,
      amount: pending.amount_guess,
      category: pending.category_guess || 'Other',
      confidence: pending.confidence,
      raw_text: pending.raw_text,
    };
    const smsBody = await fileExpense({ house, parsed, fields, photoR2Key: pending.photo_r2_key, env, deps });
    await deletePendingReview(env.DB, state.pendingReviewId);
    await clearAwaitingHouse(env.CONVERSATION_STATE, fields.from);
    return smsBody;
  }

  if (state.attempt === 0) {
    await setAwaitingHouse(env.CONVERSATION_STATE, fields.from, { pendingReviewId: state.pendingReviewId, attempt: 1 });
    const houseList = houses.map(houseLabel).join(' or ');
    return safeGenerateSmsCopy('house_selection_retry', { house_list: houseList }, env, deps);
  }

  await clearAwaitingHouse(env.CONVERSATION_STATE, fields.from);
  return safeGenerateSmsCopy('house_selection_giveup', {}, env, deps);
}

// Checks whether an inbound reply is a house correction for the most recently filed expense
// (Step 5, Feature 2). Returns the SMS body to reply with if it is a correction, or `null` if
// it isn't — a `null` return tells the caller to fall through to normal message processing,
// and leaves the correction window's state untouched so it's still available for a later reply.
async function tryApplyCorrection({ state, houses, fields, env, deps }) {
  const { houseId } = await matchHouseFromReply({ text: fields.body, houses }, env, deps);
  if (houseId == null) {
    return null;
  }

  const newHouse = houses.find((h) => h.id === houseId);
  if (!newHouse.google_sheet_id) {
    throw new Error(`House ${newHouse.id} has no google_sheet_id configured`);
  }
  const expense = await findExpenseById(env.DB, state.expenseId);
  const accessToken = await getGoogleAccessToken({ serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON, fetchImpl: deps.fetchImpl });

  await deleteSheetRow({ accessToken, spreadsheetId: state.spreadsheetId, sheetRow: state.sheetRow, fetchImpl: deps.fetchImpl });

  const photoUrl = expense.photo_r2_key ? receiptPhotoUrl(env.WORKER_BASE_URL, expense.photo_r2_key) : '';
  const appendResponse = await appendExpenseRow({
    accessToken,
    spreadsheetId: newHouse.google_sheet_id,
    row: [expense.date, expense.vendor, expense.amount, expense.category, expense.confidence, photoUrl, expense.raw_text, expense.logged_by_phone, expense.notes],
    fetchImpl: deps.fetchImpl,
  });
  const newSheetRow = extractAppendedRowNumber(appendResponse);

  await updateExpenseHouse(env.DB, { expenseId: state.expenseId, houseId: newHouse.id, sheetRow: newSheetRow });
  await clearCorrectionState(env.CONVERSATION_STATE, fields.from);

  return safeGenerateSmsCopy('correction_confirmed', { house: houseLabel(newHouse) }, env, deps);
}

export async function processExpenseMessage({ fields, photoR2Key, env, deps = {} }) {
  if (!fields.body && !photoR2Key) {
    return { smsBody: '' };
  }

  const client = await findClientByTwilioNumber(env.DB, fields.to);
  if (!client) {
    return { smsBody: '' };
  }

  const sender = await findAuthorizedSender(env.DB, client.id, fields.from);
  if (!sender) {
    return { smsBody: '' };
  }

  const houses = await findHousesForClient(env.DB, client.id);

  // A reply's text is checked against any in-flight house-selection prompt or open
  // correction window before it's treated as a brand-new expense message. A photo-only
  // message (no body text) has nothing to match against a house name, so it always skips
  // straight to normal processing — same as Step 4's existing empty-body-for-text handling.
  if (fields.body) {
    const awaitingHouse = await getAwaitingHouse(env.CONVERSATION_STATE, fields.from);
    if (awaitingHouse) {
      const smsBody = await handleAwaitingHouseReply({ state: awaitingHouse, houses, fields, env, deps });
      return { smsBody };
    }

    const correctionState = await getCorrectionState(env.CONVERSATION_STATE, fields.from);
    if (correctionState) {
      const correctionSmsBody = await tryApplyCorrection({ state: correctionState, houses, fields, env, deps });
      if (correctionSmsBody !== null) {
        return { smsBody: correctionSmsBody };
      }
      // Not a correction after all — fall through and process it as a new message below.
    }
  }

  const image = photoR2Key ? await loadStoredPhotoAsImageInput(env.RECEIPTS_BUCKET, photoR2Key) : null;

  let parsed = null;
  try {
    parsed = await parseExpense({ text: fields.body || null, image }, env, deps);
  } catch (err) {
    console.error('parseExpense failed', { error: err.message });
    parsed = null;
  }

  const houseIsAmbiguous = houses.length !== 1;

  if (houseIsAmbiguous) {
    const pendingReviewId = await insertPendingReview(env.DB, {
      clientId: client.id,
      houseId: null,
      amountGuess: parsed ? parsed.amount : null,
      categoryGuess: parsed ? parsed.category : null,
      photoR2Key,
      rawText: parsed ? parsed.raw_text : (fields.body || ''),
      confidence: parsed ? parsed.confidence : 0,
      expiresAt: pendingReviewExpiresAt(),
    });
    await setAwaitingHouse(env.CONVERSATION_STATE, fields.from, { pendingReviewId, attempt: 0 });
    const smsBody = await safeGenerateSmsCopy('house_selection', {}, env, deps);
    return { smsBody };
  }

  const house = houses[0];

  if (parsed && parsed.confidence >= CONFIDENCE_THRESHOLD && parsed.amount != null) {
    const smsBody = await fileExpense({ house, parsed, fields, photoR2Key, env, deps });
    return { smsBody };
  }

  await insertPendingReview(env.DB, {
    clientId: client.id,
    houseId: house.id,
    amountGuess: parsed ? parsed.amount : null,
    categoryGuess: parsed ? parsed.category : null,
    photoR2Key,
    rawText: parsed ? parsed.raw_text : (fields.body || ''),
    confidence: parsed ? parsed.confidence : 0,
    expiresAt: pendingReviewExpiresAt(),
  });
  const smsBody = await safeGenerateSmsCopy('low_confidence', {
    category: parsed ? parsed.category : 'Uncategorized',
  }, env, deps);
  return { smsBody };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `node expense-intake/test/expense-flow.test.js`
Expected: `PASS: expense-flow.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: all test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/expense-flow.js expense-intake/test/expense-flow.test.js
```

---

### Task 27: Docs — README updates and Step 5 self-review

**Files:**
- Modify: `expense-intake/README.md`

- [x] **Step 1: Update the `## Routes` section**

In `expense-intake/README.md`, replace the `POST /sms` bullet under `## Routes` with:

```markdown
- `POST /sms` — Twilio inbound SMS/MMS webhook. Validates `X-Twilio-Signature`,
  stores any attached photo (resized/recompressed, only the first attached
  photo is processed if a message has multiple) to R2, then either:
  - resolves an in-flight house-selection prompt or an open 10-minute
    correction window for that sender phone (Build Order step 5), or
  - parses/categorizes the expense fresh, resolves the client and house,
    and either files it to that house's Google Sheet + the `expenses`
    table (high confidence, exactly one house) or holds it in
    `pending_review` (low confidence, or an ambiguous house).

  Every successfully filed expense opens a 10-minute correction window
  (a reply naming a different house moves it); an ambiguous-house write
  opens a house-selection prompt window (a reply naming a house files it,
  a non-matching reply gets one re-ask before falling back to permanent
  `pending_review`). A repeated Twilio delivery of a message already fully
  processed (identified by `MessageSid`) replays the cached reply instead
  of reprocessing.
- `GET /receipts/:key` — serves a stored receipt photo directly from R2, no
  authentication. Used by the "Photo" column link in each house's Sheet.
```

- [x] **Step 2: Update the `## Status` section**

Replace the `## Status` section with:

```markdown
## Status

Build Order steps 1-5: repo scaffolding, D1 schema, the provider
abstraction, the Twilio inbound webhook with R2 photo storage, the full
happy-path pipeline (parse, categorize, file to Sheets/D1 or
`pending_review`), Twilio-retry dedup protection, the interactive
house-selection reply flow, and the 10-minute post-confirmation correction
window. See
`docs/superpowers/specs/2026-08-18-expense-intake-house-selection-correction-design.md`
for the house-selection/correction design. Not yet built: the `pending`
retrieval command for permanently-stuck ambiguous items (step 6), Cron
Triggers for the daily purge and monthly nudge (step 7), save-contact
onboarding (step 8), and the onboarding CLI script (step 9) — houses
currently need a `google_sheet_id` set via manual SQL before the pipeline
can file to their Sheet.
```

- [x] **Step 3: Add a migration note to the `## D1 setup` section**

Append to the end of the `## D1 setup (one-time, per environment)` section in `expense-intake/README.md`:

```markdown

Step 5 added a second migration for the `sheet_row` column (needed to
delete/move a filed expense's Sheet row on a house correction):

```bash
npx wrangler d1 execute expense-intake-db --file=migrations/0002_add_sheet_row.sql          # remote
npx wrangler d1 execute expense-intake-db --local --file=migrations/0002_add_sheet_row.sql  # local dev
```
```

- [x] **Step 4: Run the full suite one more time**

Run: `node expense-intake/test/run-all.js`
Expected: all test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 5: Stage the change**

```bash
git add expense-intake/README.md
```

---

## Self-Review — Step 5

**Spec coverage for Step 5:** Design spec Feature 1 (house-selection resolution) → Task 18/19/20/21's `matchHouseFromReply` + Task 26's `handleAwaitingHouseReply`, covering the match/retry/give-up branches exactly as specified. Feature 2 (10-minute correction window) → Task 26's `tryApplyCorrection`, covering the match-and-move / no-match-falls-through branches. The shared AI matching primitive → Tasks 18-21 (one function, four files, mirroring Step 2's `parseExpense` pattern exactly). The `sheet_row` data model change and Sheets row deletion → Task 22 (migration) + Task 23 (`extractAppendedRowNumber`/`deleteSheetRow`). The `fileExpense` extraction → Task 26, used identically by the normal auto-file path and by house-selection resolution. The three new SMS copy types → Task 25. The routing order (`awaiting_house` before `correction` before normal flow) → Task 26's `processExpenseMessage`, matching the design spec's "Message routing order (final)" section exactly.

**Not yet in scope, intentionally (later Build Order steps):** the `pending` retrieval command for items that exhaust house-selection retries (step 6) — a give-up leaves the item sitting in `pending_review` with no way to resolve it except manual SQL until step 6 exists. Cron Triggers (step 7), save-contact onboarding (step 8), and the onboarding CLI script (step 9, meaning `houses.google_sheet_id` must still be set by hand). Amount/category corrections remain out of scope per the design spec's explicit "wrong house only" decision.

**Placeholder scan:** No TBD/TODO markers. No new secrets or bindings were introduced this step (the design spec's KV state reuses the `CONVERSATION_STATE` namespace Step 4 already provisioned with a real id), so there's nothing new for the project owner to fill in beyond running the two new commands (Task 22's migration apply, already-existing KV/D1 setup).

**Type consistency:** `matchHouseFromReply({ text, houses }, env, deps) -> { houseId }` is called with the exact same shape by `handleAwaitingHouseReply` and `tryApplyCorrection` in Task 26, and its four-file provider-abstraction shape (`shared.js`/`openrouter.js`/`anthropic.js`/`index.js`) matches `parseExpense`'s established pattern from Step 2 exactly — same `{ apiKey, ..., fetchImpl }` adapter signature, same `env.AI_PROVIDER === 'anthropic'` dispatch rule. `awaiting_house` state (`{ pendingReviewId, attempt }`) and `correction` state (`{ expenseId, houseId, spreadsheetId, sheetRow }`) are written and read with identical shapes across `conversation-state.js` (Task 24), `fileExpense`/`handleAwaitingHouseReply`/`tryApplyCorrection` (Task 26). `insertExpense`'s and `insertPendingReview`'s new `id`-returning behavior (Task 22) is relied on consistently by `fileExpense` (`expenseId`) and the ambiguous-house branch (`pendingReviewId`) in Task 26 — no call site still expects the old raw `.run()` result. `extractAppendedRowNumber`/`deleteSheetRow` (Task 23) are called with the same parameter names in both `fileExpense` and `tryApplyCorrection`.

---

## Step 6: Pending review queue + pending retrieval

**Design spec:** `docs/superpowers/specs/2026-08-18-expense-intake-pending-queue-design.md` (approved by the project owner). This step builds the `"pending"` command that Step 2's already-shipped `monthly_nudge` SMS copy refers to ("Text 'pending' to review") — a client-initiated walkthrough of their `pending_review` items.

**Interface (from the design spec):** an inbound message whose trimmed, lowercased body is exactly `"pending"` starts a queue walkthrough: fetch the oldest `pending_review` row for the client, store a `pending_queue:<phone>` KV cursor, and reply with a prompt (guessed amount/category/date + instructions). While that cursor exists, the next reply is interpreted as `"skip"`, `"delete"`, or a house-name match (via Step 5's `matchHouseFromReply`) — each of which resolves/advances the cursor and, for skip/delete, auto-chains into showing the next item (or an "all caught up" message) in the same reply.

**Design decisions locked in for this step:**
- The `"pending"` keyword check happens before Step 5's `awaiting_house`/`correction` checks in `processExpenseMessage` — texting `"pending"` always starts a fresh walkthrough, even mid an unrelated Step 5 flow. Neither of those states is explicitly cleared by this; they simply expire on their own 10-minute TTLs if left unanswered, same as if the client had gone silent instead.
- The `pending_queue:<phone>` cursor check is placed immediately after the keyword check, before `awaiting_house`/`correction` — so a queue-session reply (`"skip"`, `"delete"`, a house name) also takes priority over those Step 5 states. This is a narrow, real-world-rare overlap (a client would need an active Step 5 window *and* an active pending-queue session on the same phone at once); the chosen behavior keeps each state's fallthrough scoped to "become a normal new message" rather than "become a different special state's business."
- An unrecognized reply while a `pending_queue` cursor is active (not `"skip"`/`"delete"`/a house match) leaves the cursor untouched and falls straight through to normal new-expense processing — no retry-then-give-up loop like Step 5's house-selection. This is a client-initiated, on-demand session, not a system-initiated prompt where a bounded number of attempts matters; the client can always just text `"pending"` again.
- A successful house-match resolution **clears** the `pending_queue` cursor (in addition to deleting the resolved row) rather than leaving it pointed at a now-deleted id — an implementation necessity the design spec's "no chaining after resolution" decision implies but doesn't spell out: without clearing it, the next reply (if not `"pending"`) would hit `handlePendingQueueReply` with a stale `pendingReviewId`, and `findPendingReviewById` would return `null` for a row that no longer exists.
- `"pending"` always fetches the **oldest** item, ignoring any existing cursor — a fresh command restarts from the beginning, so a previously-skipped item resurfaces on a later pass. `"skip"`/`"delete"`/resolution all advance from the *current* cursor (`id > ?`), not from the oldest again.
- Filing a queued item reuses `fileExpense` exactly as Step 5's house-selection resolution does — the item's `amount_guess`/`category_guess` (`|| 'Other'`)/`confidence`/`raw_text`/`photo_r2_key` become the `parsed` input, uniformly regardless of whether the item already had a `house_id` set. `fileExpense` opening a fresh 10-minute correction window for the newly-filed expense is inherited automatically, not special-cased here.

### Task 28: D1 query helpers — oldest/next pending review for a client

**Files:**
- Modify: `expense-intake/src/db.js`
- Modify: `expense-intake/test/db.test.js`

- [x] **Step 1: Write the failing test**

Insert this block into `main()` of `expense-intake/test/db.test.js`, immediately before `console.log('PASS: db.test.js');`, and add `findOldestPendingReviewForClient, findNextPendingReviewForClient` to the existing import from `'../src/db.js'`:

```js
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
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/db.test.js`
Expected: fails — `findOldestPendingReviewForClient`/`findNextPendingReviewForClient` are not yet exported from `../src/db.js`.

- [x] **Step 3: Add the query helpers**

Append to `expense-intake/src/db.js`:

```js

export async function findOldestPendingReviewForClient(db, clientId) {
  return db.prepare('SELECT * FROM pending_review WHERE client_id = ? ORDER BY id ASC LIMIT 1').bind(clientId).first();
}

export async function findNextPendingReviewForClient(db, clientId, afterId) {
  return db.prepare('SELECT * FROM pending_review WHERE client_id = ? AND id > ? ORDER BY id ASC LIMIT 1').bind(clientId, afterId).first();
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/db.test.js`
Expected: `PASS: db.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/db.js expense-intake/test/db.test.js
```

---

### Task 29: New SMS copy anchors — pending item prompt, pending empty

**Files:**
- Modify: `expense-intake/src/providers/shared.js`
- Modify: `expense-intake/test/providers/shared.test.js`

- [x] **Step 1: Write the failing test**

Insert this block into `main()` of `expense-intake/test/providers/shared.test.js`, immediately after the `SMS_COPY_ANCHORS.correction_confirmed` assertion added in Step 5:

```js
  assert(SMS_COPY_ANCHORS.pending_item_prompt.length === 2, 'pending_item_prompt must have 2 tone anchors');
  assert(SMS_COPY_ANCHORS.pending_empty.length === 2, 'pending_empty must have 2 tone anchors');
```

Insert this block into `main()`, immediately before `console.log('PASS: providers/shared.test.js');`:

```js
  // buildSmsCopyPrompt must work for the two new Step 6 types too
  const pendingItemPrompt = buildSmsCopyPrompt('pending_item_prompt', { amount: '10.00', category: 'Materials', date: '2026-08-12' });
  assert(pendingItemPrompt.user.includes('amount: 10.00') && pendingItemPrompt.user.includes('date: 2026-08-12'), 'pending_item_prompt must carry the actual amount/date values');
  const pendingEmptyPrompt = buildSmsCopyPrompt('pending_empty', {});
  assert(pendingEmptyPrompt.system.includes('caught up') || pendingEmptyPrompt.system.includes('clear'), 'pending_empty prompt must include its tone anchors');
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/providers/shared.test.js`
Expected: fails — `SMS_COPY_ANCHORS.pending_item_prompt` (and `pending_empty`) are `undefined`.

- [x] **Step 3: Add the new anchors**

In `expense-intake/src/providers/shared.js`, add two keys to `SMS_COPY_ANCHORS`, immediately after `correction_confirmed`:

```js
  pending_item_prompt: [
    'Pending: $[amount] guessed [category] from [date]. Reply with the house name to file it, "skip" for the next one, or "delete" to discard.',
    '$[amount], [category], logged [date] — still pending. House name to file, "skip" to move on, "delete" to remove.',
  ],
  pending_empty: [
    "You're all caught up — no pending items to review.",
    'Nothing pending right now — all clear.',
  ],
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/providers/shared.test.js`
Expected: `PASS: providers/shared.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/providers/shared.js expense-intake/test/providers/shared.test.js
```

---

### Task 30: Conversation-state — `pending_queue` KV helpers

**Files:**
- Modify: `expense-intake/src/conversation-state.js`
- Modify: `expense-intake/test/conversation-state.test.js`

- [x] **Step 1: Write the failing test**

Insert this block into `main()` of `expense-intake/test/conversation-state.test.js`, immediately before `console.log('PASS: conversation-state.test.js');`, and add `getPendingQueueState, setPendingQueueState, clearPendingQueueState` to the existing import from `'../src/conversation-state.js'`:

```js
  // pending_queue: not set
  const kv8 = createFakeKV();
  const missingQueue = await getPendingQueueState(kv8, '+15551234567');
  assert(missingQueue === null, 'getPendingQueueState must return null when nothing is stored for this phone');

  // pending_queue: set then get, with a 24-hour TTL
  const kv9 = createFakeKV();
  await setPendingQueueState(kv9, '+15551234567', { pendingReviewId: 50 });
  const queuePutCall = kv9.calls.find((c) => c.method === 'put');
  assert(queuePutCall.key === 'pending_queue:+15551234567', 'setPendingQueueState must key by pending_queue:<phone>');
  assert(queuePutCall.options.expirationTtl === 86400, 'setPendingQueueState must use a 24-hour (86400s) TTL — an on-demand session, not a time-critical window like awaiting_house/correction');
  const queueState = await getPendingQueueState(kv9, '+15551234567');
  assert(queueState.pendingReviewId === 50, 'getPendingQueueState must return the exact stored state, JSON round-tripped');

  // pending_queue: setting again for the same phone overwrites (advancing the cursor)
  const kv10 = createFakeKV();
  await setPendingQueueState(kv10, '+15551234567', { pendingReviewId: 50 });
  await setPendingQueueState(kv10, '+15551234567', { pendingReviewId: 51 });
  const advanced = await getPendingQueueState(kv10, '+15551234567');
  assert(advanced.pendingReviewId === 51, 'a second setPendingQueueState call for the same phone must overwrite the first (advancing the cursor)');

  // pending_queue: clear
  const kv11 = createFakeKV();
  await setPendingQueueState(kv11, '+15551234567', { pendingReviewId: 50 });
  await clearPendingQueueState(kv11, '+15551234567');
  assert((await getPendingQueueState(kv11, '+15551234567')) === null, 'clearPendingQueueState must delete the stored state');
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/conversation-state.test.js`
Expected: fails — `getPendingQueueState`/`setPendingQueueState`/`clearPendingQueueState` are not yet exported from `../src/conversation-state.js`.

- [x] **Step 3: Add the new helpers**

In `expense-intake/src/conversation-state.js`, add a second TTL constant and the three new functions:

```js
// expense-intake/src/conversation-state.js — add near the top, alongside STATE_TTL_SECONDS
const PENDING_QUEUE_TTL_SECONDS = 24 * 60 * 60; // an on-demand session, not a time-critical window — see Step 6's design spec
```

Append at the bottom of the file:

```js

export async function getPendingQueueState(kv, phone) {
  const value = await kv.get(`pending_queue:${phone}`, { type: 'json' });
  return value ?? null;
}

export async function setPendingQueueState(kv, phone, state) {
  await kv.put(`pending_queue:${phone}`, JSON.stringify(state), { expirationTtl: PENDING_QUEUE_TTL_SECONDS });
}

export async function clearPendingQueueState(kv, phone) {
  await kv.delete(`pending_queue:${phone}`);
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/conversation-state.test.js`
Expected: `PASS: conversation-state.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/conversation-state.js expense-intake/test/conversation-state.test.js
```

---

### Task 31: Wire the `"pending"` command and queue logic into `expense-flow.js`

**Files:**
- Modify: `expense-intake/src/expense-flow.js` (full replacement)
- Modify: `expense-intake/test/expense-flow.test.js` (append new scenarios)

- [x] **Step 1: Write the failing tests**

Add `findOldestPendingReviewForClient, findNextPendingReviewForClient` to the existing `'../src/fake-d1.js'`... (no — these come from `'../src/db.js'`, which `expense-flow.test.js` doesn't import directly; no import change needed there since the test only calls `processExpenseMessage`). Insert these scenarios into `main()` of `expense-intake/test/expense-flow.test.js`, immediately before `console.log('PASS: expense-flow.test.js');`:

```js
  // 18. "pending" with no pending items replies with the empty message, no queue state set
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
      'SELECT * FROM pending_review WHERE client_id = ? ORDER BY id ASC LIMIT 1': null,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterRouter({ copy: "You're all caught up." })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'pending', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, '"pending" with nothing pending must still produce a reply');
    assert((await kv.get('pending_queue:+15551234567')) === null, 'no queue state should be set when there is nothing pending');
  }

  // 19. "pending" (case/whitespace-insensitive) with an item shows its prompt and sets the cursor
  {
    const pendingItem = { id: 50, client_id: 1, house_id: null, amount_guess: 10, category_guess: 'Materials', photo_r2_key: null, raw_text: 'Lowes $10', confidence: 0.6, created_at: '2026-08-12T00:00:00.000Z' };
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
      'SELECT * FROM pending_review WHERE client_id = ? ORDER BY id ASC LIMIT 1': pendingItem,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterRouter({ copy: 'Pending: $10.00 guessed Materials from 2026-08-12.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: '  PENDING  ', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, '"pending" with an item must reply with its prompt');
    const state = await kv.get('pending_queue:+15551234567', { type: 'json' });
    assert(state && state.pendingReviewId === 50, '"PENDING" (any case/whitespace) must set the queue cursor to the oldest item');
  }

  // 20. "skip" advances the cursor to the next item and shows its prompt
  {
    const nextItem = { id: 51, client_id: 1, house_id: 10, amount_guess: 42, category_guess: 'Materials', photo_r2_key: null, raw_text: 'HD $42', confidence: 0.5, created_at: '2026-08-14T00:00:00.000Z' };
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
      'SELECT * FROM pending_review WHERE client_id = ? AND id > ? ORDER BY id ASC LIMIT 1': nextItem,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'pending_queue:+15551234567': JSON.stringify({ pendingReviewId: 50 }) });
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterRouter({ copy: 'Pending: $42.00 guessed Materials from 2026-08-14.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'skip', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, '"skip" must reply with the next item\'s prompt');
    const state = await kv.get('pending_queue:+15551234567', { type: 'json' });
    assert(state && state.pendingReviewId === 51, '"skip" must advance the cursor to the next item after the current one');
  }

  // 21. "skip" past the last item clears the cursor and replies with the empty message
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
      'SELECT * FROM pending_review WHERE client_id = ? AND id > ? ORDER BY id ASC LIMIT 1': null,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'pending_queue:+15551234567': JSON.stringify({ pendingReviewId: 51 }) });
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterRouter({ copy: "You're all caught up." })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'skip', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'skipping the last item must still produce a reply');
    assert((await kv.get('pending_queue:+15551234567')) === null, 'the queue cursor must be cleared once there is nothing left to show');
  }

  // 22. "delete" removes the current item and advances (chains) to the next one
  {
    const nextItem = { id: 51, client_id: 1, house_id: 10, amount_guess: 42, category_guess: 'Materials', photo_r2_key: null, raw_text: 'HD $42', confidence: 0.5, created_at: '2026-08-14T00:00:00.000Z' };
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
      'SELECT * FROM pending_review WHERE client_id = ? AND id > ? ORDER BY id ASC LIMIT 1': nextItem,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'pending_queue:+15551234567': JSON.stringify({ pendingReviewId: 50 }) });
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterRouter({ copy: 'Pending: $42.00 guessed Materials from 2026-08-14.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'delete', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, '"delete" must chain into the next item\'s prompt');
    const deleteCall = db.calls.find((c) => c.sql.includes('DELETE FROM pending_review'));
    assert(deleteCall && deleteCall.params[0] === 50, '"delete" must delete the current (cursor) item, not the next one');
    const state = await kv.get('pending_queue:+15551234567', { type: 'json' });
    assert(state && state.pendingReviewId === 51, '"delete" must advance the cursor to the next item after the deleted one');
  }

  // 23. A house-name match resolves the current item: files it, deletes it, clears the
  // queue cursor (no chaining), and replies with just the filing confirmation.
  {
    const pendingItem = { id: 50, client_id: 1, house_id: null, amount_guess: 10, category_guess: 'Materials', photo_r2_key: null, raw_text: 'Lowes $10', confidence: 0.6, created_at: '2026-08-12T00:00:00.000Z' };
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
      'SELECT * FROM pending_review WHERE id = ?': pendingItem,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'pending_queue:+15551234567': JSON.stringify({ pendingReviewId: 50 }) });
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterRouter({ match: '{"house_id":11}', copy: 'Logged: $10.00, Materials, 456 Oak Ave.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: '456 Oak', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a resolved queued item must produce a confirmation SMS body');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert && expenseInsert.params[0] === 11, 'the resolved item must be filed under the matched house');
    const pendingDelete = db.calls.find((c) => c.sql.includes('DELETE FROM pending_review'));
    assert(pendingDelete && pendingDelete.params[0] === 50, 'the resolved pending_review row must be deleted');
    assert((await kv.get('pending_queue:+15551234567')) === null, 'resolving an item must clear the queue cursor rather than chaining to the next item');
  }

  // 24. An unrecognized reply while a queue cursor is active leaves it untouched and falls
  // through to normal new-expense processing.
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'pending_queue:+15551234567': JSON.stringify({ pendingReviewId: 50 }) });
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterRouter({ match: '{"house_id":null}', parse: JSON.stringify({ vendor: 'Lowes', amount: 8, category: 'Materials', confidence: 0.9, raw_text: 'Lowes $8' }), copy: 'Logged: $8.00, Materials, Main St.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'Lowes $8 for screws', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'an unrecognized queue reply must still produce a normal SMS body from the fallthrough processing');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert, 'an unrecognized queue reply must be processed as a new expense (high confidence, single house)');
  }

  // 25. "pending" overrides an active awaiting_house window from Step 5 (checked first)
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const pendingItem = { id: 60, client_id: 1, house_id: null, amount_guess: 5, category_guess: 'Other', photo_r2_key: null, raw_text: 'x', confidence: 0.3, created_at: '2026-08-15T00:00:00.000Z' };
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
      'SELECT * FROM pending_review WHERE client_id = ? ORDER BY id ASC LIMIT 1': pendingItem,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'awaiting_house:+15551234567': JSON.stringify({ pendingReviewId: 77, attempt: 0 }) });
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterRouter({ copy: 'Pending: $5.00 guessed Other from 2026-08-15.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'pending', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, '"pending" must produce the queue prompt even with an active awaiting_house window');
    const queueState = await kv.get('pending_queue:+15551234567', { type: 'json' });
    assert(queueState && queueState.pendingReviewId === 60, '"pending" must set the queue cursor regardless of the pre-existing awaiting_house state');
    const awaitingState = await kv.get('awaiting_house:+15551234567', { type: 'json' });
    assert(awaitingState && awaitingState.pendingReviewId === 77, 'the awaiting_house state must be left untouched, not explicitly cleared, by starting a pending walkthrough');
  }
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node expense-intake/test/expense-flow.test.js`
Expected: fails — the current `processExpenseMessage` has no `"pending"`/queue handling at all, so scenarios 18-25 fail (e.g. `"pending"` gets parsed as a normal expense message instead of triggering the queue).

- [x] **Step 3: Rewrite `src/expense-flow.js`**

Replace `expense-intake/src/expense-flow.js` in full:

```js
// expense-intake/src/expense-flow.js
import { parseExpense, generateSmsCopy, matchHouseFromReply } from './providers/index.js';
import {
  findClientByTwilioNumber, findAuthorizedSender, findHousesForClient,
  insertExpense, insertPendingReview, findPendingReviewById, deletePendingReview,
  findExpenseById, updateExpenseHouse,
  findOldestPendingReviewForClient, findNextPendingReviewForClient,
} from './db.js';
import { getGoogleAccessToken } from './google-auth.js';
import { appendExpenseRow, extractAppendedRowNumber, deleteSheetRow } from './sheets.js';
import {
  getAwaitingHouse, setAwaitingHouse, clearAwaitingHouse,
  getCorrectionState, setCorrectionState, clearCorrectionState,
  getPendingQueueState, setPendingQueueState, clearPendingQueueState,
} from './conversation-state.js';

const CONFIDENCE_THRESHOLD = 0.7; // tunable — see Step 4's Design decisions note in the plan
const PENDING_REVIEW_TTL_DAYS = 60; // matches spec's 60-day auto-purge (Cron Trigger is Build Order step 7)

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function pendingReviewExpiresAt() {
  return new Date(Date.now() + PENDING_REVIEW_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function receiptPhotoUrl(baseUrl, photoR2Key) {
  return `${baseUrl}/receipts/${encodeURIComponent(photoR2Key)}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function loadStoredPhotoAsImageInput(bucket, photoR2Key) {
  const object = await bucket.get(photoR2Key);
  if (!object) {
    throw new Error(`Stored receipt photo not found in R2: ${photoR2Key}`);
  }
  const bytes = await object.arrayBuffer();
  return { base64: arrayBufferToBase64(bytes), mediaType: 'image/jpeg' };
}

function houseLabel(house) {
  return house.nickname || house.address;
}

function pendingItemVars(item) {
  return {
    amount: item.amount_guess != null ? item.amount_guess.toFixed(2) : '0.00',
    category: item.category_guess || 'Uncategorized',
    date: item.created_at ? item.created_at.slice(0, 10) : '',
  };
}

// Static fallback copy, used only if the AI copy-generation call itself fails. Deliberately
// NOT the raw SMS_COPY_ANCHORS strings from providers/shared.js (Step 2) — those contain
// literal bracket placeholders like "[amount]" meant only as few-shot prompt examples, never
// meant to be sent to a client verbatim. These fallbacks substitute the real values instead.
const FALLBACK_SMS_COPY = {
  confirmation: (vars) => `Logged: $${vars.amount}, ${vars.category}, ${vars.house}.`,
  low_confidence: (vars) => `Logged this as ${vars.category} but wasn't fully sure — flagged it for you to double check.`,
  house_selection: () => 'Which house is this for? Address or nickname works.',
  house_selection_retry: (vars) => `Sorry, could you confirm — is this for ${vars.house_list}?`,
  house_selection_giveup: () => 'No worries — saved this one for you to sort out later.',
  correction_confirmed: (vars) => `Updated — moved to ${vars.house}.`,
  pending_item_prompt: (vars) => `Pending: $${vars.amount}, ${vars.category}, ${vars.date}. Reply with the house name to file it, "skip" for the next one, or "delete" to discard.`,
  pending_empty: () => "You're all caught up — no pending items to review.",
};

// A copy-generation failure must never re-trigger writes that already succeeded. By the
// time this is called, the relevant write has already committed — if generateSmsCopy then
// throws (rate limit, timeout, network blip, all realistic for an external API call) and
// that exception were allowed to propagate, handleSmsWebhook's outer catch would turn it
// into a 500, Twilio would retry the whole webhook, and — since nothing gets cached on a 500
// (Task 16) — the retry would reprocess from scratch. Falling back to static copy instead
// means the pipeline always finishes, gets cached, and Twilio never retries a message whose
// writes already succeeded.
async function safeGenerateSmsCopy(type, vars, env, deps) {
  try {
    return await generateSmsCopy(type, vars, env, deps);
  } catch (err) {
    console.error('generateSmsCopy failed, using fallback copy', { error: err.message, type });
    // Defensive: FALLBACK_SMS_COPY only covers the types this module currently calls with.
    // If a future call site invokes this with a type that hasn't been given a fallback
    // entry, FALLBACK_SMS_COPY[type] is undefined — calling it would throw a TypeError from
    // inside this catch block itself. A generic last-resort string keeps the guarantee
    // unconditional.
    const fallback = FALLBACK_SMS_COPY[type];
    return fallback ? fallback(vars) : 'We logged this — reply if something looks off.';
  }
}

// Writes an already-parsed, already-house-resolved expense to the house's Sheet + the
// expenses table, and opens the 10-minute correction window for it. Shared by the normal
// high-confidence auto-file path, by a house-selection reply that resolves a pending item
// (Step 5), and by resolving an item from the pending queue (Step 6) — all three need the
// exact same write sequence.
async function fileExpense({ house, parsed, fields, photoR2Key, env, deps }) {
  if (!house.google_sheet_id) {
    // A house with no Sheet set up is an onboarding gap, not a runtime parsing issue —
    // surface it loudly (visible in wrangler tail) rather than silently losing the expense
    // into pending_review, which would mask a real setup bug during manual (pre-step-9) onboarding.
    throw new Error(`House ${house.id} has no google_sheet_id configured`);
  }
  const accessToken = await getGoogleAccessToken({ serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON, fetchImpl: deps.fetchImpl });
  const photoUrl = photoR2Key ? receiptPhotoUrl(env.WORKER_BASE_URL, photoR2Key) : '';
  const appendResponse = await appendExpenseRow({
    accessToken,
    spreadsheetId: house.google_sheet_id,
    row: [todayIso(), parsed.vendor, parsed.amount, parsed.category, parsed.confidence, photoUrl, parsed.raw_text, fields.from, ''],
    fetchImpl: deps.fetchImpl,
  });
  const sheetRow = extractAppendedRowNumber(appendResponse);
  const expenseId = await insertExpense(env.DB, {
    houseId: house.id,
    date: todayIso(),
    vendor: parsed.vendor,
    amount: parsed.amount,
    category: parsed.category,
    confidence: parsed.confidence,
    photoR2Key,
    rawText: parsed.raw_text,
    loggedByPhone: fields.from,
    notes: '',
    sheetRow,
  });
  await setCorrectionState(env.CONVERSATION_STATE, fields.from, {
    expenseId,
    houseId: house.id,
    spreadsheetId: house.google_sheet_id,
    sheetRow,
  });
  return safeGenerateSmsCopy('confirmation', {
    amount: parsed.amount != null ? parsed.amount.toFixed(2) : '0.00',
    category: parsed.category,
    house: houseLabel(house),
  }, env, deps);
}

// Resolves an in-flight house-selection prompt (Step 5, Feature 1). Always returns a
// non-null SMS body — every branch here (match, retry, give-up) produces a reply.
async function handleAwaitingHouseReply({ state, houses, fields, env, deps }) {
  const { houseId } = await matchHouseFromReply({ text: fields.body, houses }, env, deps);

  if (houseId != null) {
    const house = houses.find((h) => h.id === houseId);
    const pending = await findPendingReviewById(env.DB, state.pendingReviewId);
    const parsed = {
      vendor: null,
      amount: pending.amount_guess,
      category: pending.category_guess || 'Other',
      confidence: pending.confidence,
      raw_text: pending.raw_text,
    };
    const smsBody = await fileExpense({ house, parsed, fields, photoR2Key: pending.photo_r2_key, env, deps });
    await deletePendingReview(env.DB, state.pendingReviewId);
    await clearAwaitingHouse(env.CONVERSATION_STATE, fields.from);
    return smsBody;
  }

  if (state.attempt === 0) {
    await setAwaitingHouse(env.CONVERSATION_STATE, fields.from, { pendingReviewId: state.pendingReviewId, attempt: 1 });
    const houseList = houses.map(houseLabel).join(' or ');
    return safeGenerateSmsCopy('house_selection_retry', { house_list: houseList }, env, deps);
  }

  await clearAwaitingHouse(env.CONVERSATION_STATE, fields.from);
  return safeGenerateSmsCopy('house_selection_giveup', {}, env, deps);
}

// Checks whether an inbound reply is a house correction for the most recently filed expense
// (Step 5, Feature 2). Returns the SMS body to reply with if it is a correction, or `null` if
// it isn't — a `null` return tells the caller to fall through to normal message processing,
// and leaves the correction window's state untouched so it's still available for a later reply.
async function tryApplyCorrection({ state, houses, fields, env, deps }) {
  const { houseId } = await matchHouseFromReply({ text: fields.body, houses }, env, deps);
  if (houseId == null) {
    return null;
  }

  const newHouse = houses.find((h) => h.id === houseId);
  if (!newHouse.google_sheet_id) {
    throw new Error(`House ${newHouse.id} has no google_sheet_id configured`);
  }
  const expense = await findExpenseById(env.DB, state.expenseId);
  const accessToken = await getGoogleAccessToken({ serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON, fetchImpl: deps.fetchImpl });

  await deleteSheetRow({ accessToken, spreadsheetId: state.spreadsheetId, sheetRow: state.sheetRow, fetchImpl: deps.fetchImpl });

  const photoUrl = expense.photo_r2_key ? receiptPhotoUrl(env.WORKER_BASE_URL, expense.photo_r2_key) : '';
  const appendResponse = await appendExpenseRow({
    accessToken,
    spreadsheetId: newHouse.google_sheet_id,
    row: [expense.date, expense.vendor, expense.amount, expense.category, expense.confidence, photoUrl, expense.raw_text, expense.logged_by_phone, expense.notes],
    fetchImpl: deps.fetchImpl,
  });
  const newSheetRow = extractAppendedRowNumber(appendResponse);

  await updateExpenseHouse(env.DB, { expenseId: state.expenseId, houseId: newHouse.id, sheetRow: newSheetRow });
  await clearCorrectionState(env.CONVERSATION_STATE, fields.from);

  return safeGenerateSmsCopy('correction_confirmed', { house: houseLabel(newHouse) }, env, deps);
}

// Shows a pending item's prompt and sets the queue cursor to it, or — if there is no item —
// clears the cursor and replies with the "all caught up" message. Shared by the initial
// "pending" command and by every skip/delete/resolution advance (Step 6).
async function showPendingItemOrEmpty({ item, phone, env, deps }) {
  if (!item) {
    await clearPendingQueueState(env.CONVERSATION_STATE, phone);
    return safeGenerateSmsCopy('pending_empty', {}, env, deps);
  }
  await setPendingQueueState(env.CONVERSATION_STATE, phone, { pendingReviewId: item.id });
  return safeGenerateSmsCopy('pending_item_prompt', pendingItemVars(item), env, deps);
}

async function handlePendingCommand({ client, fields, env, deps }) {
  const item = await findOldestPendingReviewForClient(env.DB, client.id);
  return showPendingItemOrEmpty({ item, phone: fields.from, env, deps });
}

// Interprets a reply while a pending-queue cursor is active: "skip"/"delete" advance the
// cursor (chaining into the next item's prompt, or the empty message), a house-name match
// resolves the current item. Returns `null` if the reply is none of these, telling the
// caller to fall through to normal message processing — the cursor is left untouched in
// that case, still valid for a later reply.
async function handlePendingQueueReply({ state, client, houses, fields, env, deps }) {
  const normalized = fields.body.trim().toLowerCase();

  if (normalized === 'skip') {
    const next = await findNextPendingReviewForClient(env.DB, client.id, state.pendingReviewId);
    return showPendingItemOrEmpty({ item: next, phone: fields.from, env, deps });
  }

  if (normalized === 'delete') {
    await deletePendingReview(env.DB, state.pendingReviewId);
    const next = await findNextPendingReviewForClient(env.DB, client.id, state.pendingReviewId);
    return showPendingItemOrEmpty({ item: next, phone: fields.from, env, deps });
  }

  const { houseId } = await matchHouseFromReply({ text: fields.body, houses }, env, deps);
  if (houseId == null) {
    return null;
  }

  const house = houses.find((h) => h.id === houseId);
  const pending = await findPendingReviewById(env.DB, state.pendingReviewId);
  const parsed = {
    vendor: null,
    amount: pending.amount_guess,
    category: pending.category_guess || 'Other',
    confidence: pending.confidence,
    raw_text: pending.raw_text,
  };
  const smsBody = await fileExpense({ house, parsed, fields, photoR2Key: pending.photo_r2_key, env, deps });
  await deletePendingReview(env.DB, state.pendingReviewId);
  // No chaining after a resolution (per the design spec) — but the cursor still must be
  // cleared, not just left alone, since it now points at a row that no longer exists. Leaving
  // it would make the client's *next* reply (if not "pending") hit this function again with a
  // stale pendingReviewId, and findPendingReviewById would resolve to null.
  await clearPendingQueueState(env.CONVERSATION_STATE, fields.from);
  return smsBody;
}

export async function processExpenseMessage({ fields, photoR2Key, env, deps = {} }) {
  if (!fields.body && !photoR2Key) {
    return { smsBody: '' };
  }

  const client = await findClientByTwilioNumber(env.DB, fields.to);
  if (!client) {
    return { smsBody: '' };
  }

  const sender = await findAuthorizedSender(env.DB, client.id, fields.from);
  if (!sender) {
    return { smsBody: '' };
  }

  const houses = await findHousesForClient(env.DB, client.id);

  // A reply's text is checked against the pending-review queue command/cursor, then any
  // in-flight house-selection prompt or open correction window, before it's treated as a
  // brand-new expense message. A photo-only message (no body text) has nothing to match
  // against a house name or command keyword, so it always skips straight to normal
  // processing — same as Step 4's existing empty-body-for-text handling.
  if (fields.body) {
    const normalizedBody = fields.body.trim().toLowerCase();

    if (normalizedBody === 'pending') {
      const smsBody = await handlePendingCommand({ client, fields, env, deps });
      return { smsBody };
    }

    const pendingQueueState = await getPendingQueueState(env.CONVERSATION_STATE, fields.from);
    if (pendingQueueState) {
      const queueSmsBody = await handlePendingQueueReply({ state: pendingQueueState, client, houses, fields, env, deps });
      if (queueSmsBody !== null) {
        return { smsBody: queueSmsBody };
      }
      // Not a recognized queue action — fall through and process it as a new message below.
    }

    const awaitingHouse = await getAwaitingHouse(env.CONVERSATION_STATE, fields.from);
    if (awaitingHouse) {
      const smsBody = await handleAwaitingHouseReply({ state: awaitingHouse, houses, fields, env, deps });
      return { smsBody };
    }

    const correctionState = await getCorrectionState(env.CONVERSATION_STATE, fields.from);
    if (correctionState) {
      const correctionSmsBody = await tryApplyCorrection({ state: correctionState, houses, fields, env, deps });
      if (correctionSmsBody !== null) {
        return { smsBody: correctionSmsBody };
      }
      // Not a correction after all — fall through and process it as a new message below.
    }
  }

  const image = photoR2Key ? await loadStoredPhotoAsImageInput(env.RECEIPTS_BUCKET, photoR2Key) : null;

  let parsed = null;
  try {
    parsed = await parseExpense({ text: fields.body || null, image }, env, deps);
  } catch (err) {
    console.error('parseExpense failed', { error: err.message });
    parsed = null;
  }

  const houseIsAmbiguous = houses.length !== 1;

  if (houseIsAmbiguous) {
    const pendingReviewId = await insertPendingReview(env.DB, {
      clientId: client.id,
      houseId: null,
      amountGuess: parsed ? parsed.amount : null,
      categoryGuess: parsed ? parsed.category : null,
      photoR2Key,
      rawText: parsed ? parsed.raw_text : (fields.body || ''),
      confidence: parsed ? parsed.confidence : 0,
      expiresAt: pendingReviewExpiresAt(),
    });
    await setAwaitingHouse(env.CONVERSATION_STATE, fields.from, { pendingReviewId, attempt: 0 });
    const smsBody = await safeGenerateSmsCopy('house_selection', {}, env, deps);
    return { smsBody };
  }

  const house = houses[0];

  if (parsed && parsed.confidence >= CONFIDENCE_THRESHOLD && parsed.amount != null) {
    const smsBody = await fileExpense({ house, parsed, fields, photoR2Key, env, deps });
    return { smsBody };
  }

  await insertPendingReview(env.DB, {
    clientId: client.id,
    houseId: house.id,
    amountGuess: parsed ? parsed.amount : null,
    categoryGuess: parsed ? parsed.category : null,
    photoR2Key,
    rawText: parsed ? parsed.raw_text : (fields.body || ''),
    confidence: parsed ? parsed.confidence : 0,
    expiresAt: pendingReviewExpiresAt(),
  });
  const smsBody = await safeGenerateSmsCopy('low_confidence', {
    category: parsed ? parsed.category : 'Uncategorized',
  }, env, deps);
  return { smsBody };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `node expense-intake/test/expense-flow.test.js`
Expected: `PASS: expense-flow.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: all test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/expense-flow.js expense-intake/test/expense-flow.test.js
```

---

### Task 32: Docs — README updates and Step 6 self-review

**Files:**
- Modify: `expense-intake/README.md`

- [x] **Step 1: Update the `## Routes` section**

In `expense-intake/README.md`, add a new bullet to the `POST /sms` route's description in `## Routes`, immediately after the existing correction-window/house-selection bullet paragraph:

```markdown

  A client can also text `"pending"` at any time (this check runs before
  the house-selection/correction checks above) to walk through their
  `pending_review` items one at a time: reply with a house name to file
  the current item, `"skip"` to see the next one, or `"delete"` to discard
  it — `"skip"`/`"delete"` immediately show the next item (or an
  "all caught up" message) in the same reply.
```

- [x] **Step 2: Update the `## Status` section**

Replace `## Status` in `expense-intake/README.md` with:

```markdown
## Status

Build Order steps 1-6: repo scaffolding, D1 schema, the provider
abstraction, the Twilio inbound webhook with R2 photo storage, the full
happy-path pipeline (parse, categorize, file to Sheets/D1 or
`pending_review`), Twilio-retry dedup protection, the interactive
house-selection reply flow, the 10-minute post-confirmation correction
window, and the client-initiated `"pending"` review queue. See
`docs/superpowers/specs/2026-08-18-expense-intake-house-selection-correction-design.md`
and
`docs/superpowers/specs/2026-08-18-expense-intake-pending-queue-design.md`
for those two steps' designs. Not yet built: Cron Triggers for the daily
purge and monthly nudge (step 7), save-contact onboarding (step 8), and
the onboarding CLI script (step 9) — houses currently need a
`google_sheet_id` set via manual SQL before the pipeline can file to
their Sheet.
```

- [x] **Step 3: Run the full suite one more time**

Run: `node expense-intake/test/run-all.js`
Expected: all test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 4: Stage the change**

```bash
git add expense-intake/README.md
```

---

## Self-Review — Step 6

**Spec coverage for Step 6:** The `"pending"` trigger and its priority over Step 5's states → Task 31's `processExpenseMessage` routing order, matching the design spec's "Trigger and priority" section exactly (keyword checked first, `pending_queue` cursor checked second, `awaiting_house`/`correction` unchanged after that). The queue cursor (`{ pendingReviewId }`, oldest-on-command / next-after-cursor-on-advance) → Task 28's two D1 helpers + Task 30's three KV helpers + Task 31's `handlePendingCommand`/`handlePendingQueueReply`. `"skip"`/`"delete"`/house-match actions and the chaining-vs-no-chaining distinction → Task 31's `handlePendingQueueReply` and `showPendingItemOrEmpty`, covering all three actions plus the "falls through, cursor untouched" no-match case. Filing a queued item via the shared `fileExpense` helper, uniformly regardless of whether the item already had a `house_id` → Task 31, reusing Step 5's `fileExpense` verbatim. The two new SMS copy types → Task 29.

**Not yet in scope, intentionally (later Build Order steps):** the monthly nudge Cron Trigger that actually tells a client how many items are waiting (step 7) — the `"pending"` command built here works standalone and doesn't depend on it. Save-contact onboarding (step 8) and the onboarding CLI script (step 9, meaning `houses.google_sheet_id` must still be set by hand). Amount/category correction from within the queue remains out of scope, matching Step 5's "house only" correction philosophy.

**Placeholder scan:** No TBD/TODO markers. No new secrets or bindings were introduced this step (reuses the existing `CONVERSATION_STATE` KV namespace and `DB` binding).

**Type consistency:** `showPendingItemOrEmpty({ item, phone, env, deps })` is called identically by `handlePendingCommand` and both branches of `handlePendingQueueReply` in Task 31. `pending_queue` state (`{ pendingReviewId }`) is written/read/cleared with the same shape across `conversation-state.js` (Task 30) and every call site in `expense-flow.js` (Task 31) — no call site expects a richer shape (e.g. an item list) than what's actually stored. `findOldestPendingReviewForClient`/`findNextPendingReviewForClient` (Task 28) are called with the same argument order (`db, clientId[, afterId]`) in both their own tests and Task 31. The house-match resolution branch in `handlePendingQueueReply` mirrors Step 5's `handleAwaitingHouseReply` match branch line-for-line in how it builds `parsed` from a `pending_review` row — the same shape (`vendor: null`, `category: category_guess || 'Other'`, etc.) is used both places, so a future change to that mapping would need to stay in sync in exactly two spots, both now clearly cross-referenced in comments.

---

## Step 7: Cron Triggers — daily purge, monthly nudge

**Design spec:** `docs/superpowers/specs/2026-08-18-expense-intake-cron-triggers-design.md` (approved by the project owner). Two independent Cloudflare Cron Triggers: a daily silent purge of expired `pending_review` rows, and a monthly SMS nudge to every authorized sender of every active client with outstanding items.

**Interface (from the design spec):** a new outbound-send function, `sendSms({ accountSid, authToken, from, to, body, fetchImpl })` in `src/twilio.js` (Twilio's REST Messages resource, Basic Auth) — the first outbound capability this Worker has needed, since every prior reply has been a synchronous TwiML response to an inbound webhook. A new `src/scheduled.js` exports `purgeExpiredPendingReviews(env, deps)` and `sendMonthlyNudges(env, deps)`, dispatched from a new `scheduled(event, env, ctx)` handler in `src/index.js` based on `event.cron`.

**Design decisions locked in for this step:**
- The daily purge is silent — no client-facing message, just a server-side log of how many rows were deleted (`console.log`, visible in `wrangler tail`).
- The monthly nudge goes to **every** phone number on `authorized_senders` for a client with pending items, not just one "primary" contact — the schema has no primary-contact flag, and any authorized sender might be the one who needs to act.
- The nudge count is simply the client's **current total** `pending_review` row count at the moment the cron fires — no delta tracking, no per-item "already nudged" state. A client with unresolved items gets reminded every month until the queue is cleared.
- One sender's outbound send failing (bad number, transient Twilio error) must not stop the rest of that client's senders, or the next client in the loop, from being nudged — `sendMonthlyNudges` catches and logs per-send failures rather than letting one throw abort the whole run.
- `safeGenerateSmsCopy` (previously a private helper in `expense-flow.js`, used for the AI-with-static-fallback pattern every other SMS in this project already uses) is exported so `scheduled.js` can reuse it rather than duplicating the fallback logic — `FALLBACK_SMS_COPY` gains a `monthly_nudge` entry using the same `[X]` var name already baked into Step 2's shipped `SMS_COPY_ANCHORS.monthly_nudge` text.
- `wrangler.toml`'s two cron expressions are named constants in `index.js` (`DAILY_PURGE_CRON`/`MONTHLY_NUDGE_CRON`) so `event.cron`'s dispatch is self-documenting rather than requiring the reader to decode cron syntax to know which job fired.

### Task 33: Outbound SMS — `sendSms` in `twilio.js`

**Files:**
- Modify: `expense-intake/src/twilio.js`
- Modify: `expense-intake/test/twilio.test.js`

- [x] **Step 1: Write the failing test**

Update the import at the top of `expense-intake/test/twilio.test.js`:

```js
import { parseFormBody, verifyTwilioSignature, extractWebhookFields, sendSms } from '../src/twilio.js';
```

Add this helper function above `async function main()`:

```js
function fakeFetch(ok, status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}
```

Insert this block into `main()`, immediately before `console.log('PASS: twilio.test.js');`:

```js
  // sendSms
  const sendFetch = fakeFetch(true, 201, { sid: 'SM123', status: 'queued' });
  const sendResult = await sendSms({ accountSid: 'AC_test', authToken: 'test_auth_token', from: '+15559876543', to: '+15551234567', body: 'Test message', fetchImpl: sendFetch });
  assert(sendResult.sid === 'SM123', 'sendSms must return the parsed Twilio API response');
  const sendCall = sendFetch.calls[0];
  assert(sendCall.url === 'https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json', 'sendSms must hit the Twilio Messages resource for the given accountSid');
  assert(sendCall.init.headers.Authorization === `Basic ${Buffer.from('AC_test:test_auth_token').toString('base64')}`, 'sendSms must send Basic Auth using accountSid:authToken');
  const sendBody = new URLSearchParams(sendCall.init.body);
  assert(sendBody.get('To') === '+15551234567' && sendBody.get('From') === '+15559876543' && sendBody.get('Body') === 'Test message', 'sendSms must form-encode To/From/Body');

  // sendSms: error path
  const failFetch = fakeFetch(false, 400, { code: 21211, message: 'Invalid To Phone Number' });
  let threwSend = false;
  try {
    await sendSms({ accountSid: 'AC_test', authToken: 'test_auth_token', from: '+15559876543', to: 'bad', body: 'x', fetchImpl: failFetch });
  } catch (err) {
    threwSend = true;
    assert(err.message === 'Invalid To Phone Number', 'sendSms must surface the Twilio API error message');
  }
  assert(threwSend, 'a non-2xx Twilio response must throw');
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/twilio.test.js`
Expected: fails — `sendSms` is not yet exported from `../src/twilio.js`.

- [x] **Step 3: Add the function**

Append to `expense-intake/src/twilio.js`:

```js

// Twilio's outbound REST API — the first outbound-send capability this Worker has needed;
// every reply built in earlier Build Order steps has been a synchronous TwiML response to
// an inbound webhook, which a Cron Trigger has no inbound request to piggyback on.
export async function sendSms({ accountSid, authToken, from, to, body, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const basicAuth = btoa(`${accountSid}:${authToken}`);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.message) || `Twilio send failed with status ${response.status}`;
    throw new Error(message);
  }
  return data;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/twilio.test.js`
Expected: `PASS: twilio.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/twilio.js expense-intake/test/twilio.test.js
```

---

### Task 34: D1 query helpers — expired purge, active-clients-with-pending, senders-for-client

**Files:**
- Modify: `expense-intake/src/db.js`
- Modify: `expense-intake/test/db.test.js`

- [x] **Step 1: Write the failing test**

Add `deleteExpiredPendingReviews, findActiveClientsWithPendingCounts, findAuthorizedSendersForClient` to the existing import from `'../src/db.js'` in `expense-intake/test/db.test.js`. Insert this block into `main()`, immediately before `console.log('PASS: db.test.js');`:

```js
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
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/db.test.js`
Expected: fails — `deleteExpiredPendingReviews`/`findActiveClientsWithPendingCounts`/`findAuthorizedSendersForClient` are not yet exported from `../src/db.js`.

- [x] **Step 3: Add the query helpers**

Append to `expense-intake/src/db.js`:

```js

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
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/db.test.js`
Expected: `PASS: db.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/db.js expense-intake/test/db.test.js
```

---

### Task 35: Export `safeGenerateSmsCopy` and add the `monthly_nudge` fallback

**Files:**
- Modify: `expense-intake/src/expense-flow.js`

No new test file for this task — the `monthly_nudge` fallback is exercised by Task 36's `scheduled.test.js`, which imports and calls the now-exported `safeGenerateSmsCopy` indirectly through `sendMonthlyNudges`. This is a mechanical, non-behavior-changing edit to already-tested code (exporting a function and adding one more entry to an existing lookup table), not new business logic in its own right.

- [x] **Step 1: Export the function**

In `expense-intake/src/expense-flow.js`, change:

```js
async function safeGenerateSmsCopy(type, vars, env, deps) {
```

to:

```js
export async function safeGenerateSmsCopy(type, vars, env, deps) {
```

- [x] **Step 2: Add the fallback entry**

In `expense-intake/src/expense-flow.js`, add to `FALLBACK_SMS_COPY`, immediately after `pending_empty`:

```js
  monthly_nudge: (vars) => `${vars.X} items waiting on your OK. Text 'pending' to review.`,
```

- [x] **Step 3: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 4: Stage the change**

```bash
git add expense-intake/src/expense-flow.js
```

---

### Task 36: `src/scheduled.js` — the two Cron-triggered jobs

**Files:**
- Create: `expense-intake/src/scheduled.js`
- Create: `expense-intake/test/scheduled.test.js`
- Modify: `expense-intake/test/run-all.js`

- [x] **Step 1: Write the failing test**

```js
// expense-intake/test/scheduled.test.js
import { purgeExpiredPendingReviews, sendMonthlyNudges } from '../src/scheduled.js';
import { createFakeD1 } from './fake-d1.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    for (const [match, respond] of handlers) {
      if (url.includes(match)) return respond(url, init);
    }
    throw new Error(`Unhandled fetch in test: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function chatResponse(content) {
  return { choices: [{ message: { content } }] };
}

function baseEnv(db, overrides = {}) {
  return {
    DB: db,
    AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'or_key',
    TWILIO_ACCOUNT_SID: 'AC_test',
    TWILIO_AUTH_TOKEN: 'test_auth_token',
    ...overrides,
  };
}

async function main() {
  // purgeExpiredPendingReviews
  {
    const db = createFakeD1({ 'DELETE FROM pending_review WHERE expires_at < ?': { success: true, meta: { changes: 4 } } });
    const result = await purgeExpiredPendingReviews(baseEnv(db));
    assert(result.deletedCount === 4, 'purgeExpiredPendingReviews must return the number of rows deleted');
    const call = db.calls[0];
    assert(call.sql.includes('DELETE FROM pending_review'), 'must delete from pending_review');
    assert(/^\d{4}-\d{2}-\d{2}T/.test(call.params[0]), 'must bind an ISO timestamp as the expiry cutoff');
  }

  // sendMonthlyNudges: no active clients with pending items -> nothing sent
  {
    const db = createFakeD1({
      "SELECT c.id AS client_id, c.twilio_number AS twilio_number, COUNT(pr.id) AS pending_count FROM clients c JOIN pending_review pr ON pr.client_id = c.id WHERE c.status = 'active' GROUP BY c.id": [],
    });
    const fetchImpl = fakeFetch([]);
    const result = await sendMonthlyNudges(baseEnv(db), { fetchImpl });
    assert(result.sentCount === 0, 'no active clients with pending items must send nothing');
    assert(fetchImpl.calls.length === 0, 'no fetch calls should happen when there is nothing to nudge about');
  }

  // sendMonthlyNudges: one client, two authorized senders -> both get nudged
  {
    const pendingCounts = [{ client_id: 1, twilio_number: '+15559876543', pending_count: 2 }];
    const senders = [{ id: 5, client_id: 1, phone_number: '+15551234567' }, { id: 6, client_id: 1, phone_number: '+15559998888' }];
    const db = createFakeD1({
      "SELECT c.id AS client_id, c.twilio_number AS twilio_number, COUNT(pr.id) AS pending_count FROM clients c JOIN pending_review pr ON pr.client_id = c.id WHERE c.status = 'active' GROUP BY c.id": pendingCounts,
      'SELECT * FROM authorized_senders WHERE client_id = ?': senders,
    });
    const fetchImpl = fakeFetch([
      ['openrouter.ai', async () => ({ ok: true, status: 200, json: async () => chatResponse("2 items waiting on your OK. Text 'pending' to review.") })],
      ['api.twilio.com', async () => ({ ok: true, status: 201, json: async () => ({ sid: 'SM1' }) })],
    ]);
    const result = await sendMonthlyNudges(baseEnv(db), { fetchImpl });
    assert(result.sentCount === 2, 'both authorized senders must be counted as sent');
    const twilioCalls = fetchImpl.calls.filter((c) => c.url.includes('api.twilio.com'));
    assert(twilioCalls.length === 2, 'must send one outbound SMS per authorized sender');
    const toNumbers = twilioCalls.map((c) => new URLSearchParams(c.init.body).get('To'));
    assert(toNumbers.includes('+15551234567') && toNumbers.includes('+15559998888'), 'must send to every authorized sender phone number, not just one');
    const fromNumbers = twilioCalls.map((c) => new URLSearchParams(c.init.body).get('From'));
    assert(fromNumbers.every((from) => from === '+15559876543'), "must send from the client's own twilio_number");
  }

  // sendMonthlyNudges: one sender's send fails -> the other still gets nudged, no throw
  {
    const pendingCounts = [{ client_id: 1, twilio_number: '+15559876543', pending_count: 1 }];
    const senders = [{ id: 5, client_id: 1, phone_number: '+15551234567' }, { id: 6, client_id: 1, phone_number: '+15559998888' }];
    const db = createFakeD1({
      "SELECT c.id AS client_id, c.twilio_number AS twilio_number, COUNT(pr.id) AS pending_count FROM clients c JOIN pending_review pr ON pr.client_id = c.id WHERE c.status = 'active' GROUP BY c.id": pendingCounts,
      'SELECT * FROM authorized_senders WHERE client_id = ?': senders,
    });
    let twilioCallCount = 0;
    const fetchImpl = fakeFetch([
      ['openrouter.ai', async () => ({ ok: true, status: 200, json: async () => chatResponse("1 item waiting on your OK. Text 'pending' to review.") })],
      ['api.twilio.com', async () => {
        twilioCallCount++;
        if (twilioCallCount === 1) {
          return { ok: false, status: 400, json: async () => ({ code: 21211, message: 'Invalid To Phone Number' }) };
        }
        return { ok: true, status: 201, json: async () => ({ sid: 'SM2' }) };
      }],
    ]);
    const result = await sendMonthlyNudges(baseEnv(db), { fetchImpl });
    assert(result.sentCount === 1, 'a failed send for one sender must not be counted, but must not stop the other from being sent');
  }

  // sendMonthlyNudges: generateSmsCopy fails -> falls back to static monthly_nudge copy
  {
    const pendingCounts = [{ client_id: 1, twilio_number: '+15559876543', pending_count: 3 }];
    const senders = [{ id: 5, client_id: 1, phone_number: '+15551234567' }];
    const db = createFakeD1({
      "SELECT c.id AS client_id, c.twilio_number AS twilio_number, COUNT(pr.id) AS pending_count FROM clients c JOIN pending_review pr ON pr.client_id = c.id WHERE c.status = 'active' GROUP BY c.id": pendingCounts,
      'SELECT * FROM authorized_senders WHERE client_id = ?': senders,
    });
    const fetchImpl = fakeFetch([
      ['openrouter.ai', async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'upstream error' } }) })],
      ['api.twilio.com', async () => ({ ok: true, status: 201, json: async () => ({ sid: 'SM3' }) })],
    ]);
    const result = await sendMonthlyNudges(baseEnv(db), { fetchImpl });
    assert(result.sentCount === 1, 'a copy-generation failure must not prevent the nudge from being sent with fallback copy');
    const twilioCall = fetchImpl.calls.find((c) => c.url.includes('api.twilio.com'));
    const sentBody = new URLSearchParams(twilioCall.init.body).get('Body');
    assert(sentBody === "3 items waiting on your OK. Text 'pending' to review.", 'the fallback monthly_nudge copy must substitute the real pending count');
  }

  console.log('PASS: scheduled.test.js');
}

await main();
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/scheduled.test.js`
Expected: fails with a module-not-found error for `../src/scheduled.js` (it doesn't exist yet).

- [x] **Step 3: Write the module**

```js
// expense-intake/src/scheduled.js
import { deleteExpiredPendingReviews, findActiveClientsWithPendingCounts, findAuthorizedSendersForClient } from './db.js';
import { sendSms } from './twilio.js';
import { safeGenerateSmsCopy } from './expense-flow.js';

export async function purgeExpiredPendingReviews(env, deps = {}) {
  const nowIso = new Date().toISOString();
  const deletedCount = await deleteExpiredPendingReviews(env.DB, nowIso);
  console.log('Purged expired pending_review rows', { deletedCount });
  return { deletedCount };
}

export async function sendMonthlyNudges(env, deps = {}) {
  const clients = await findActiveClientsWithPendingCounts(env.DB);
  let sentCount = 0;
  for (const client of clients) {
    const senders = await findAuthorizedSendersForClient(env.DB, client.client_id);
    const body = await safeGenerateSmsCopy('monthly_nudge', { X: client.pending_count }, env, deps);
    for (const sender of senders) {
      try {
        await sendSms({
          accountSid: env.TWILIO_ACCOUNT_SID,
          authToken: env.TWILIO_AUTH_TOKEN,
          from: client.twilio_number,
          to: sender.phone_number,
          body,
          fetchImpl: deps.fetchImpl,
        });
        sentCount++;
      } catch (err) {
        // One sender's outbound send failing (bad number, Twilio hiccup) must not stop the
        // rest of this client's senders, or the next client in the loop, from being nudged.
        console.error('Failed to send monthly nudge', { clientId: client.client_id, phone: sender.phone_number, error: err.message });
      }
    }
  }
  console.log('Sent monthly nudges', { sentCount });
  return { sentCount };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/scheduled.test.js`
Expected: `PASS: scheduled.test.js`

- [x] **Step 5: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './migration-0002.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './providers/index.test.js';
import './twilio.test.js';
import './receipt-storage.test.js';
import './db.test.js';
import './google-auth.test.js';
import './sheets.test.js';
import './twiml.test.js';
import './expense-flow.test.js';
import './message-dedup.test.js';
import './conversation-state.test.js';
import './scheduled.test.js';
import './handlers.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 6: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: all test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 7: Stage the change**

```bash
git add expense-intake/src/scheduled.js expense-intake/test/scheduled.test.js expense-intake/test/run-all.js
```

---

### Task 37: Wire `scheduled()` into `index.js`, `wrangler.toml` crons, and docs

**Files:**
- Modify: `expense-intake/src/index.js` (full replacement)
- Modify: `expense-intake/test/index.test.js`
- Modify: `expense-intake/wrangler.toml`
- Modify: `expense-intake/README.md`

- [x] **Step 1: Write the failing test**

Insert this block into `main()` of `expense-intake/test/index.test.js`, immediately before `console.log('PASS: index.test.js');`:

```js
  // scheduled(): the daily purge cron deletes expired pending_review rows through the real handler
  const purgeDb = createFakeD1({ 'DELETE FROM pending_review WHERE expires_at < ?': { success: true, meta: { changes: 2 } } });
  await workerModule.scheduled({ cron: '0 3 * * *' }, baseEnv({ DB: purgeDb }), {});
  assert(purgeDb.calls.some((c) => c.sql.includes('DELETE FROM pending_review')), 'the daily purge cron must delete expired pending_review rows through the real scheduled handler');

  // scheduled(): the monthly nudge cron routes to sendMonthlyNudges through the real handler.
  // No active clients have pending items in this fake DB, so sendMonthlyNudges returns before
  // ever calling generateSmsCopy/sendSms — this test only proves the cron-string dispatch is
  // wired correctly, not the nudge-sending logic itself (that's Task 36's scheduled.test.js).
  const nudgeDb = createFakeD1({
    "SELECT c.id AS client_id, c.twilio_number AS twilio_number, COUNT(pr.id) AS pending_count FROM clients c JOIN pending_review pr ON pr.client_id = c.id WHERE c.status = 'active' GROUP BY c.id": [],
  });
  await workerModule.scheduled({ cron: '0 9 1 * *' }, baseEnv({ DB: nudgeDb }), {});
  assert(nudgeDb.calls.some((c) => c.sql.includes('COUNT(pr.id)')), 'the monthly nudge cron must query for active clients with pending items through the real scheduled handler');

  // scheduled(): an unrecognized cron string must not throw
  let threwUnrecognized = false;
  try {
    await workerModule.scheduled({ cron: '* * * * *' }, baseEnv({ DB: createFakeD1() }), {});
  } catch {
    threwUnrecognized = true;
  }
  assert(!threwUnrecognized, 'an unrecognized cron string must be logged, not thrown, so a Worker misconfiguration cannot crash a scheduled invocation');
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/index.test.js`
Expected: fails — `workerModule.scheduled` is not yet defined (the current `export default` only has `fetch`).

- [x] **Step 3: Rewrite `src/index.js`**

Replace `expense-intake/src/index.js` in full:

```js
// expense-intake/src/index.js — full replacement
import { handleSmsWebhook, handleGetReceipt } from './handlers.js';
import { purgeExpiredPendingReviews, sendMonthlyNudges } from './scheduled.js';

const DAILY_PURGE_CRON = '0 3 * * *';
const MONTHLY_NUDGE_CRON = '0 9 1 * *';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/sms') {
      const bodyText = await request.text();
      const signature = request.headers.get('X-Twilio-Signature') || '';
      const result = await handleSmsWebhook({ url: request.url, bodyText, signature, env });
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/receipts/')) {
      let key;
      try {
        key = decodeURIComponent(url.pathname.slice('/receipts/'.length));
      } catch {
        return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
      }
      const result = await handleGetReceipt({ key, bucket: env.RECEIPTS_BUCKET });
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      });
    }

    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async scheduled(event, env, ctx) {
    if (event.cron === DAILY_PURGE_CRON) {
      await purgeExpiredPendingReviews(env);
      return;
    }
    if (event.cron === MONTHLY_NUDGE_CRON) {
      await sendMonthlyNudges(env);
      return;
    }
    console.error('Unrecognized cron trigger fired', { cron: event.cron });
  },
};
```

- [x] **Step 4: Run tests to verify they pass**

Run: `node expense-intake/test/index.test.js`
Expected: `PASS: index.test.js`

- [x] **Step 5: Add the `[triggers]` crons to `wrangler.toml`**

Replace the trailing comment block in `expense-intake/wrangler.toml`:

```toml
# CONVERSATION_STATE (above) is also used by Build Order step 5 for house-selection
# pending state and the 10-minute correction window — one namespace, multiple key
# prefixes ("processed:", and step 5's own prefix once it exists).
# Routes and [[triggers]] cron entries are added in later Build Order steps (7-ish)
# once the code that uses them exists.
```

with:

```toml
# CONVERSATION_STATE (above) is also used by Build Order steps 5-6 for house-selection
# state, the 10-minute correction window, and the pending-review queue cursor — one
# namespace, multiple key prefixes.

[triggers]
crons = [
  "0 3 * * *",  # daily purge — DAILY_PURGE_CRON in src/index.js
  "0 9 1 * *",  # monthly nudge — MONTHLY_NUDGE_CRON in src/index.js
]
```

- [x] **Step 6: Update the README**

In `expense-intake/README.md`, add a new `## Routes` bullet (as its own top-level list item, after the existing `GET /receipts/:key` bullet) and a new section after `## Twilio secrets`:

```markdown
- **Cron Triggers** (not an HTTP route): a daily job purges expired
  `pending_review` rows (silent, no client-facing message), and a monthly
  job texts every authorized sender of every active client with
  outstanding pending items, using the same `TWILIO_ACCOUNT_SID`/
  `TWILIO_AUTH_TOKEN` secrets as the inbound webhook. See
  `docs/superpowers/specs/2026-08-18-expense-intake-cron-triggers-design.md`.
```

```markdown
## Testing Cron Triggers locally

`wrangler dev` exposes a special endpoint for firing a configured Cron
Trigger without waiting for its real schedule:

\`\`\`bash
curl "http://localhost:8787/__scheduled?cron=0+3+*+*+*"   # daily purge
curl "http://localhost:8787/__scheduled?cron=0+9+1+*+*"   # monthly nudge
\`\`\`

The plain-Node test suite (`test/scheduled.test.js`, `test/index.test.js`)
covers the actual purge/nudge logic and the `event.cron` dispatch without
needing `wrangler dev` at all — this is only useful for an end-to-end
manual check against real Twilio/D1.
```

Update the `## Status` section:

```markdown
## Status

Build Order steps 1-7: repo scaffolding, D1 schema, the provider
abstraction, the Twilio inbound webhook with R2 photo storage, the full
happy-path pipeline (parse, categorize, file to Sheets/D1 or
`pending_review`), Twilio-retry dedup protection, the interactive
house-selection reply flow, the 10-minute post-confirmation correction
window, the client-initiated `"pending"` review queue, and the daily
purge / monthly nudge Cron Triggers. See the three specs under
`docs/superpowers/specs/2026-08-18-*` for those steps' designs. Not yet
built: save-contact onboarding (step 8) and the onboarding CLI script
(step 9) — houses currently need a `google_sheet_id` set via manual SQL
before the pipeline can file to their Sheet.
```

- [x] **Step 7: Run the full suite one more time**

Run: `node expense-intake/test/run-all.js`
Expected: all test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 8: Stage the change**

```bash
git add expense-intake/src/index.js expense-intake/test/index.test.js expense-intake/wrangler.toml expense-intake/README.md
```

---

## Self-Review — Step 7

**Spec coverage for Step 7:** The outbound-SMS capability → Task 33's `sendSms`, matching the design spec's "REST API, Basic Auth" description exactly (same account already used for inbound signature verification and Step 3's MMS media fetch). The silent daily purge → Task 34's `deleteExpiredPendingReviews` + Task 36's `purgeExpiredPendingReviews`, with no SMS copy type or send call anywhere in that path. The monthly nudge fanning out to every authorized sender → Task 34's `findAuthorizedSendersForClient` + Task 36's `sendMonthlyNudges`'s inner loop, and its test explicitly asserts both sender phone numbers receive a send. The "current total, no delta tracking" nudge count → `findActiveClientsWithPendingCounts`'s plain `COUNT(pr.id)` with no "already nudged" filter anywhere in the query or the calling code. Per-send failure isolation → Task 36's try/catch around each `sendSms` call, tested explicitly with one failing send alongside one succeeding one. `event.cron` dispatch → Task 37's `scheduled()` handler and its three test scenarios (purge cron, nudge cron, unrecognized cron).

**Not yet in scope, intentionally (later Build Order steps):** save-contact onboarding (step 8) and the onboarding CLI script (step 9, meaning `houses.google_sheet_id` must still be set by hand, and clients/houses/authorized_senders rows still need manual SQL to create).

**Placeholder scan:** No TBD/TODO markers. No new secrets were introduced — `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` already exist from Step 3 and are reused as-is for outbound sends. The two cron expressions in `wrangler.toml` are real, working schedules (not placeholders) with an explicit "tunable" callout in the design spec for their exact times.

**Type consistency:** `sendSms({ accountSid, authToken, from, to, body, fetchImpl })`'s parameter names match the existing `fetchImpl`-injection convention used by every other outbound-fetch function in this codebase (`appendExpenseRow`, `anthropicMessagesRequest`, etc.). `purgeExpiredPendingReviews(env, deps)`/`sendMonthlyNudges(env, deps)` match the `(env, deps = {})` shape `processExpenseMessage` already established, even though neither currently uses every field of `deps` beyond `fetchImpl`. `findActiveClientsWithPendingCounts`'s result shape (`{ client_id, twilio_number, pending_count }`) is consumed with those exact three field names in `sendMonthlyNudges`, and its test's fixture data matches that shape exactly. `safeGenerateSmsCopy`'s export (Task 35) doesn't change its signature at all — every existing call site inside `expense-flow.js` continues to call it exactly as before, and `scheduled.js` (Task 36) calls it with the identical `(type, vars, env, deps)` argument order.

---

## Step 8: Save-contact onboarding

**Design spec:** `docs/superpowers/specs/2026-08-18-expense-intake-save-contact-onboarding-design.md` (approved by the project owner). Sends a new authorized sender a tappable vCard the first time they text in, so their phone shows a friendly business name instead of a raw number on future texts. `authorized_senders.contact_card_sent_at` has existed since Step 1's schema with nothing writing to it — this step is what finally does.

**Interface (from the design spec):** a new public route, `GET /contact-card/:clientId`, serves a generated `.vcf` file. On every inbound message, right after the sender is confirmed authorized, `processExpenseMessage` checks `sender.contact_card_sent_at`; if `null`, it sends an outbound MMS (Step 7's `sendSms`, extended with an optional `mediaUrl` param) pointing at that route, then marks `contact_card_sent_at`. The whole sequence is internally failure-proofed so it can never fail or block the sender's actual reply.

**Design decisions locked in for this step:**
- `GET /contact-card/:clientId` is public and unauthenticated, same trust model as `GET /receipts/:key` — but for a different reason: a vCard isn't sensitive data (just a business name and the client's own already-public Twilio number), so there's no unguessable-key requirement; a plain sequential `clientId` is fine.
- The vCard-send is `await`ed inline (not threaded through `ctx.waitUntil`) but wrapped in its own try/catch — a failure is logged and `contact_card_sent_at` is left `null` (retried on the sender's next message), but never propagates to affect the main reply. This is a deliberate simplification over true background dispatch, called out explicitly in the design spec, since `ctx.waitUntil` would require plumbing `ctx` through every layer from `src/index.js`'s `fetch` handler down to `expense-flow.js` for a non-critical onboarding nicety.
- `sendSms`'s `mediaUrl` parameter is optional — when omitted (every existing call site), behavior is byte-for-byte unchanged from Step 7; only `maybeSendContactCard`'s new call site supplies it.
- The MMS body text goes through the same `safeGenerateSmsCopy` AI-with-fallback pattern as every other outbound message, via a new `contact_card_intro` copy type — not because wording variety matters for a one-time-per-sender message, but for architectural consistency (every outbound message in this project is generated the same way).

### Task 38: D1 query helpers — `findClientById`, `markContactCardSent`

**Files:**
- Modify: `expense-intake/src/db.js`
- Modify: `expense-intake/test/db.test.js`

- [x] **Step 1: Write the failing test**

Add `findClientById, markContactCardSent` to the existing import from `'../src/db.js'` in `expense-intake/test/db.test.js`. Insert this block into `main()`, immediately before `console.log('PASS: db.test.js');`:

```js
  // findClientById
  const clientById = { id: 1, business_name: 'Acme Rentals', twilio_number: '+15559876543' };
  const db20 = createFakeD1({ 'SELECT * FROM clients WHERE id = ?': clientById });
  const foundClientById = await findClientById(db20, 1);
  assert(foundClientById === clientById, 'findClientById must return the row from the fake DB');
  assert(db20.calls[0].params[0] === 1, 'must bind the client id as the query parameter');

  // findClientById: not found
  const db21 = createFakeD1({ 'SELECT * FROM clients WHERE id = ?': null });
  const missingClientById = await findClientById(db21, 999);
  assert(missingClientById === null, 'findClientById must return null when no client matches');

  // markContactCardSent
  const db22 = createFakeD1();
  await markContactCardSent(db22, 5, '2026-08-18T12:00:00.000Z');
  assert(db22.calls[0].sql.includes('UPDATE authorized_senders SET contact_card_sent_at'), 'markContactCardSent must UPDATE authorized_senders.contact_card_sent_at');
  assert(
    JSON.stringify(db22.calls[0].params) === JSON.stringify(['2026-08-18T12:00:00.000Z', 5]),
    'markContactCardSent must bind the timestamp then the sender id, matching the SET ... WHERE id = ? clause order'
  );
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/db.test.js`
Expected: fails — `findClientById`/`markContactCardSent` are not yet exported from `../src/db.js`.

- [x] **Step 3: Add the query helpers**

Append to `expense-intake/src/db.js`:

```js

export async function findClientById(db, id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
}

export async function markContactCardSent(db, senderId, sentAtIso) {
  return db.prepare('UPDATE authorized_senders SET contact_card_sent_at = ? WHERE id = ?').bind(sentAtIso, senderId).run();
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/db.test.js`
Expected: `PASS: db.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/db.js expense-intake/test/db.test.js
```

---

### Task 39: `src/vcard.js` — pure vCard builder

**Files:**
- Create: `expense-intake/src/vcard.js`
- Create: `expense-intake/test/vcard.test.js`
- Modify: `expense-intake/test/run-all.js`

- [x] **Step 1: Write the failing test**

```js
// expense-intake/test/vcard.test.js
import { buildVCard } from '../src/vcard.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  const vcard = buildVCard({ businessName: 'Acme Rentals', phoneNumber: '+15559876543' });
  assert(vcard.startsWith('BEGIN:VCARD\r\n'), 'vCard must start with the BEGIN:VCARD line, CRLF-terminated per spec');
  assert(vcard.includes('VERSION:3.0\r\n'), 'vCard must declare VERSION:3.0');
  assert(vcard.includes('FN:Acme Rentals Expense Tracker\r\n'), 'vCard must set the formatted name to the business name plus "Expense Tracker"');
  assert(vcard.includes('TEL;TYPE=CELL:+15559876543\r\n'), "vCard must include the client's Twilio number as a cell TEL field");
  assert(vcard.trim().endsWith('END:VCARD'), 'vCard must end with the END:VCARD line');

  console.log('PASS: vcard.test.js');
}

await main();
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/vcard.test.js`
Expected: fails with a module-not-found error for `../src/vcard.js` (it doesn't exist yet).

- [x] **Step 3: Write the module**

```js
// expense-intake/src/vcard.js
export function buildVCard({ businessName, phoneNumber }) {
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${businessName} Expense Tracker`,
    `TEL;TYPE=CELL:${phoneNumber}`,
    'END:VCARD',
  ].join('\r\n') + '\r\n';
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/vcard.test.js`
Expected: `PASS: vcard.test.js`

- [x] **Step 5: Wire the new test into the runner**

```js
// expense-intake/test/run-all.js
import './schema.test.js';
import './migration-0002.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './providers/index.test.js';
import './twilio.test.js';
import './receipt-storage.test.js';
import './db.test.js';
import './google-auth.test.js';
import './sheets.test.js';
import './twiml.test.js';
import './vcard.test.js';
import './expense-flow.test.js';
import './message-dedup.test.js';
import './conversation-state.test.js';
import './scheduled.test.js';
import './handlers.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
```

- [x] **Step 6: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: all test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 7: Stage the change**

```bash
git add expense-intake/src/vcard.js expense-intake/test/vcard.test.js expense-intake/test/run-all.js
```

---

### Task 40: New SMS copy anchor — `contact_card_intro`

**Files:**
- Modify: `expense-intake/src/providers/shared.js`
- Modify: `expense-intake/test/providers/shared.test.js`

- [x] **Step 1: Write the failing test**

Insert this block into `main()` of `expense-intake/test/providers/shared.test.js`, immediately after the `SMS_COPY_ANCHORS.pending_empty` assertion added in Step 6:

```js
  assert(SMS_COPY_ANCHORS.contact_card_intro.length === 2, 'contact_card_intro must have 2 tone anchors');
```

Insert this block into `main()`, immediately before `console.log('PASS: providers/shared.test.js');`:

```js
  // buildSmsCopyPrompt must work for the new Step 8 type too
  const contactCardPrompt = buildSmsCopyPrompt('contact_card_intro', { business: 'Acme Rentals' });
  assert(contactCardPrompt.user.includes('business: Acme Rentals'), 'contact_card_intro prompt must carry the actual business name');
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/providers/shared.test.js`
Expected: fails — `SMS_COPY_ANCHORS.contact_card_intro` is `undefined`.

- [x] **Step 3: Add the new anchor**

In `expense-intake/src/providers/shared.js`, add one key to `SMS_COPY_ANCHORS`, immediately after `pending_empty`:

```js
  contact_card_intro: [
    "Save this number for [business]'s expense tracker — text a receipt anytime.",
    "This is [business]'s expense line — save the contact so texts are easy to spot.",
  ],
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/providers/shared.test.js`
Expected: `PASS: providers/shared.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/providers/shared.js expense-intake/test/providers/shared.test.js
```

---

### Task 41: `sendSms` — optional `mediaUrl` for MMS

**Files:**
- Modify: `expense-intake/src/twilio.js`
- Modify: `expense-intake/test/twilio.test.js`

- [x] **Step 1: Write the failing test**

Insert this block into `main()` of `expense-intake/test/twilio.test.js`, immediately after the existing `sendSms` error-path assertion, before `console.log('PASS: twilio.test.js');`:

```js
  // sendSms: optional mediaUrl turns the send into an MMS
  const mmsFetch = fakeFetch(true, 201, { sid: 'SM456', status: 'queued' });
  await sendSms({ accountSid: 'AC_test', authToken: 'test_auth_token', from: '+15559876543', to: '+15551234567', body: 'Save this contact', mediaUrl: 'https://expense-intake.example.com/contact-card/1', fetchImpl: mmsFetch });
  const mmsBody = new URLSearchParams(mmsFetch.calls[0].init.body);
  assert(mmsBody.get('MediaUrl') === 'https://expense-intake.example.com/contact-card/1', 'sendSms must include MediaUrl in the form body when provided');

  // sendSms: mediaUrl omitted must not add a MediaUrl field at all (the earlier plain-SMS call above)
  assert(sendBody.get('MediaUrl') === null, 'sendSms must not send a MediaUrl field for a plain SMS with no mediaUrl provided');
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/twilio.test.js`
Expected: fails — the current `sendSms` never adds a `MediaUrl` field, so `mmsBody.get('MediaUrl')` is `null` instead of the expected URL.

- [x] **Step 3: Add the parameter**

Replace `sendSms` in `expense-intake/src/twilio.js`:

```js
// Twilio's outbound REST API — the first outbound-send capability this Worker has needed;
// every reply built in earlier Build Order steps has been a synchronous TwiML response to
// an inbound webhook, which a Cron Trigger has no inbound request to piggyback on. An
// optional mediaUrl turns the send into an MMS (Step 8's vCard delivery) — Twilio's Messages
// API treats SMS/MMS through the same endpoint, MediaUrl is just an optional form field.
export async function sendSms({ accountSid, authToken, from, to, body, mediaUrl, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const basicAuth = btoa(`${accountSid}:${authToken}`);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = { To: to, From: from, Body: body };
  if (mediaUrl) {
    params.MediaUrl = mediaUrl;
  }
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.message) || `Twilio send failed with status ${response.status}`;
    throw new Error(message);
  }
  return data;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/twilio.test.js`
Expected: `PASS: twilio.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/twilio.js expense-intake/test/twilio.test.js
```

---

### Task 42: Wire `maybeSendContactCard` into `expense-flow.js`

**Files:**
- Modify: `expense-intake/src/expense-flow.js`
- Modify: `expense-intake/test/expense-flow.test.js`

- [x] **Step 1: Write the failing tests**

In `expense-intake/test/expense-flow.test.js`, make these three targeted changes:

1. Add `TWILIO_ACCOUNT_SID: 'AC_test', TWILIO_AUTH_TOKEN: 'test_auth_token',` to the object returned by `baseEnv`, alongside the existing `WORKER_BASE_URL` line — `maybeSendContactCard`'s `sendSms` call needs these, and no existing scenario asserts on their absence.

2. Change the shared `sender` fixture near the top of `main()`:

```js
  const sender = { id: 5, client_id: 1, phone_number: '+15551234567' };
```

to:

```js
  // contact_card_sent_at is set (already onboarded) so scenarios 1-25 below, all written
  // before Step 8 existed, don't unexpectedly trigger a vCard send — that new behavior gets
  // its own dedicated scenarios (26-28) with a fresh, not-yet-onboarded sender.
  const sender = { id: 5, client_id: 1, phone_number: '+15551234567', contact_card_sent_at: '2026-01-01T00:00:00.000Z' };
```

3. Insert these three new scenarios into `main()`, immediately before `console.log('PASS: expense-flow.test.js');`:

```js
  // 26. A new sender (contact_card_sent_at null) triggers a vCard MMS send on their first
  // message, marks contact_card_sent_at, and the main reply still proceeds normally.
  {
    const newSender = { id: 9, client_id: 1, phone_number: '+15551234567', contact_card_sent_at: null };
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': newSender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['api.twilio.com', jsonOk({ sid: 'SM_vcard' })],
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.9, raw_text: 'HD $42.50' }),
        'Logged: $42.50, Materials, Main St.'
      )],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'HD $42.50', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, "a new sender's first message must still process normally and produce a reply");
    const twilioCall = fetchImpl.calls.find((c) => c.url.includes('api.twilio.com'));
    assert(twilioCall, 'a new sender must trigger an outbound vCard MMS send');
    const twilioBody = new URLSearchParams(twilioCall.init.body);
    assert(twilioBody.get('MediaUrl') === 'https://expense-intake.example.workers.dev/contact-card/1', "the vCard MMS must point MediaUrl at this client's /contact-card route");
    assert(twilioBody.get('To') === '+15551234567', 'the vCard MMS must go to the sender who just texted in');
    const markSentCall = db.calls.find((c) => c.sql.includes('UPDATE authorized_senders SET contact_card_sent_at'));
    assert(markSentCall && markSentCall.params[1] === 9, 'contact_card_sent_at must be marked for this sender once the vCard send succeeds');
  }

  // 27. A vCard MMS send failure must not affect the main reply, and contact_card_sent_at
  // must NOT be marked, so it's retried on the sender's next message.
  {
    const newSender = { id: 9, client_id: 1, phone_number: '+15551234567', contact_card_sent_at: null };
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': newSender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['api.twilio.com', async () => ({ ok: false, status: 400, json: async () => ({ code: 21211, message: 'Invalid To Phone Number' }) })],
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.9, raw_text: 'HD $42.50' }),
        'Logged: $42.50, Materials, Main St.'
      )],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'HD $42.50', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a failed vCard send must not prevent the main reply from being produced');
    const markSentCall = db.calls.find((c) => c.sql.includes('UPDATE authorized_senders SET contact_card_sent_at'));
    assert(!markSentCall, 'contact_card_sent_at must not be marked when the vCard send fails, so it is retried next time');
  }

  // 28. A sender who already has contact_card_sent_at set must not trigger another vCard send.
  {
    const onboardedSender = { id: 5, client_id: 1, phone_number: '+15551234567', contact_card_sent_at: '2026-01-01T00:00:00.000Z' };
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': onboardedSender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.9, raw_text: 'HD $42.50' }),
        'Logged: $42.50, Materials, Main St.'
      )],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'HD $42.50', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'an already-onboarded sender must still process normally');
    const twilioCall = fetchImpl.calls.find((c) => c.url.includes('api.twilio.com'));
    assert(!twilioCall, 'an already-onboarded sender must not trigger another vCard send attempt');
  }
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node expense-intake/test/expense-flow.test.js`
Expected: fails — `processExpenseMessage` has no `maybeSendContactCard` logic yet, so scenario 26/27's `twilioCall` assertions fail (no `api.twilio.com` call ever happens) and scenario 28 fails too until the guard exists — but note it will currently "pass" for the wrong reason (no vCard logic exists at all yet); the meaningful failures are 26 and 27.

- [x] **Step 3: Wire it in**

Update the import block near the top of `expense-intake/src/expense-flow.js`:

```js
import {
  findClientByTwilioNumber, findAuthorizedSender, findHousesForClient,
  insertExpense, insertPendingReview, findPendingReviewById, deletePendingReview,
  findExpenseById, updateExpenseHouse,
  findOldestPendingReviewForClient, findNextPendingReviewForClient,
  markContactCardSent,
} from './db.js';
import { sendSms } from './twilio.js';
import { getGoogleAccessToken } from './google-auth.js';
```

Add this new function to `expense-intake/src/expense-flow.js`, immediately before `export async function processExpenseMessage`:

```js
// Sends a new authorized sender a tappable vCard the first time they text in — see Step 8's
// design spec. This must never fail or block the sender's actual reply: any error here is
// caught and logged, leaving contact_card_sent_at null so it's simply retried on their next
// message, instead of propagating up and turning a successful expense log into a 500.
async function maybeSendContactCard({ client, sender, fields, env, deps }) {
  if (sender.contact_card_sent_at) {
    return;
  }
  try {
    const body = await safeGenerateSmsCopy('contact_card_intro', { business: client.business_name }, env, deps);
    const mediaUrl = `${env.WORKER_BASE_URL}/contact-card/${client.id}`;
    await sendSms({
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      from: client.twilio_number,
      to: fields.from,
      body,
      mediaUrl,
      fetchImpl: deps.fetchImpl,
    });
    await markContactCardSent(env.DB, sender.id, new Date().toISOString());
  } catch (err) {
    console.error('Failed to send contact card', { senderId: sender.id, error: err.message });
  }
}
```

In `processExpenseMessage`, add a call right after the sender lookup succeeds:

```js
  const sender = await findAuthorizedSender(env.DB, client.id, fields.from);
  if (!sender) {
    return { smsBody: '' };
  }

  await maybeSendContactCard({ client, sender, fields, env, deps });

  const houses = await findHousesForClient(env.DB, client.id);
```

- [x] **Step 4: Run tests to verify they pass**

Run: `node expense-intake/test/expense-flow.test.js`
Expected: `PASS: expense-flow.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: all test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/expense-flow.js expense-intake/test/expense-flow.test.js
```

---

### Task 43: `handleGetContactCard` route handler

**Files:**
- Modify: `expense-intake/src/handlers.js`
- Modify: `expense-intake/test/handlers.test.js`

- [x] **Step 1: Write the failing test**

Update the import at the top of `expense-intake/test/handlers.test.js`:

```js
import { handleSmsWebhook, handleGetReceipt, handleGetContactCard } from '../src/handlers.js';
```

Insert this block into `main()`, immediately before `console.log('PASS: handlers.test.js');`:

```js
  // handleGetContactCard: found
  {
    const clientRow = { id: 1, business_name: 'Acme Rentals', twilio_number: '+15559876543' };
    const db = createFakeD1({ 'SELECT * FROM clients WHERE id = ?': clientRow });
    const found = await handleGetContactCard({ clientId: '1', db });
    assert(found.status === 200 && found.contentType === 'text/vcard', 'a valid client id must serve a vCard with the correct content type');
    assert(found.body.includes('FN:Acme Rentals Expense Tracker'), "the served vCard must carry the client's business name");
  }

  // handleGetContactCard: client not found
  {
    const db = createFakeD1({ 'SELECT * FROM clients WHERE id = ?': null });
    const missing = await handleGetContactCard({ clientId: '999', db });
    assert(missing.status === 404, 'an unknown client id must 404');
  }

  // handleGetContactCard: non-numeric clientId must 404, not attempt a broken query
  {
    const db = createFakeD1();
    const bad = await handleGetContactCard({ clientId: 'not-a-number', db });
    assert(bad.status === 404, 'a non-numeric clientId must 404 rather than attempting a query');
  }
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/handlers.test.js`
Expected: fails — `handleGetContactCard` is not yet exported from `../src/handlers.js`.

- [x] **Step 3: Add the handler**

Update the import block at the top of `expense-intake/src/handlers.js`:

```js
// expense-intake/src/handlers.js
import { parseFormBody, verifyTwilioSignature, extractWebhookFields } from './twilio.js';
import { generateReceiptKey, storeReceiptPhoto } from './receipt-storage.js';
import { processExpenseMessage } from './expense-flow.js';
import { buildTwiml } from './twiml.js';
import { getCachedReply, cacheReply } from './message-dedup.js';
import { findClientById } from './db.js';
import { buildVCard } from './vcard.js';
```

Append to `expense-intake/src/handlers.js`:

```js

// This route is deliberately public and unauthenticated, same as handleGetReceipt — but for
// a different reason: a vCard isn't sensitive data (just a business name and the client's
// own already-public-facing Twilio number), so there's no unguessable-key requirement here,
// unlike a receipt photo. See Step 8's design spec.
export async function handleGetContactCard({ clientId, db }) {
  const id = Number.parseInt(clientId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return { status: 404, contentType: 'text/plain', body: 'Not found' };
  }
  const client = await findClientById(db, id);
  if (!client) {
    return { status: 404, contentType: 'text/plain', body: 'Not found' };
  }
  const vcard = buildVCard({ businessName: client.business_name, phoneNumber: client.twilio_number });
  return { status: 200, contentType: 'text/vcard', body: vcard };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node expense-intake/test/handlers.test.js`
Expected: `PASS: handlers.test.js`

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `node expense-intake/test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 6: Stage the change**

```bash
git add expense-intake/src/handlers.js expense-intake/test/handlers.test.js
```

---

### Task 44: Wire the route into `index.js`, and docs

**Files:**
- Modify: `expense-intake/src/index.js`
- Modify: `expense-intake/test/index.test.js`
- Modify: `expense-intake/README.md`

No `wrangler.toml` change is needed this step — `DB`, `WORKER_BASE_URL`, and the `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` secrets all already exist from earlier steps.

- [x] **Step 1: Write the failing test**

Insert this block into `main()` of `expense-intake/test/index.test.js`, immediately after the existing `GET /receipts/:key for a missing key -> 404` scenario, before the `scheduled()` scenarios added in Step 7:

```js
  // GET /contact-card/:clientId through the real routing layer
  const contactCardDb = createFakeD1({ 'SELECT * FROM clients WHERE id = ?': { id: 1, business_name: 'Acme Rentals', twilio_number: '+15559876543' } });
  request = new Request('https://expense-intake.example.com/contact-card/1', { method: 'GET' });
  response = await workerModule.fetch(request, baseEnv({ DB: contactCardDb }));
  assert(response.status === 200 && response.headers.get('Content-Type') === 'text/vcard', 'a valid client id must serve a vCard through the real GET /contact-card/:clientId route');

  // GET /contact-card/:clientId for an unknown client -> 404
  request = new Request('https://expense-intake.example.com/contact-card/999', { method: 'GET' });
  response = await workerModule.fetch(request, baseEnv({ DB: createFakeD1({ 'SELECT * FROM clients WHERE id = ?': null }) }));
  assert(response.status === 404, 'an unknown client id must 404 through the real route');
```

- [x] **Step 2: Run test to verify it fails**

Run: `node expense-intake/test/index.test.js`
Expected: fails — `GET /contact-card/1` falls through to the catch-all 404 JSON response instead of serving a vCard, since `src/index.js` has no route for it yet.

- [x] **Step 3: Wire the route**

Update the import and add a new route branch in `expense-intake/src/index.js`:

```js
import { handleSmsWebhook, handleGetReceipt, handleGetContactCard } from './handlers.js';
```

Insert this branch immediately after the existing `GET /receipts/` branch, before the catch-all 404:

```js
    if (request.method === 'GET' && url.pathname.startsWith('/contact-card/')) {
      const clientId = url.pathname.slice('/contact-card/'.length);
      const result = await handleGetContactCard({ clientId, db: env.DB });
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      });
    }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `node expense-intake/test/index.test.js`
Expected: `PASS: index.test.js`

- [x] **Step 5: Update the README**

In `expense-intake/README.md`, add a new `## Routes` bullet, immediately after the `GET /receipts/:key` bullet:

```markdown
- `GET /contact-card/:clientId` — serves a generated vCard for the given
  client, no authentication (not sensitive data — just a business name
  and the client's own already-public Twilio number). Used as the
  `MediaUrl` for the one-time save-contact MMS a new authorized sender
  gets on their first message.
```

Update the `## Status` section:

```markdown
## Status

Build Order steps 1-8: repo scaffolding, D1 schema, the provider
abstraction, the Twilio inbound webhook with R2 photo storage, the full
happy-path pipeline (parse, categorize, file to Sheets/D1 or
`pending_review`), Twilio-retry dedup protection, the interactive
house-selection reply flow, the 10-minute post-confirmation correction
window, the client-initiated `"pending"` review queue, the daily purge /
monthly nudge Cron Triggers, and save-contact onboarding (a one-time
vCard MMS to each newly authorized sender). See the specs under
`docs/superpowers/specs/2026-08-18-*` for those steps' designs. Not yet
built: the onboarding CLI script (step 9) — houses/clients/authorized
senders still need manual SQL to create, and `houses.google_sheet_id`
must still be set by hand.
```

- [x] **Step 6: Run the full suite one more time**

Run: `node expense-intake/test/run-all.js`
Expected: all test files `PASS:`, then `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [x] **Step 7: Stage the change**

```bash
git add expense-intake/src/index.js expense-intake/test/index.test.js expense-intake/README.md
```

---

## Self-Review — Step 8

**Spec coverage for Step 8:** The vCard-via-MMS delivery mechanism → Task 39's `buildVCard` + Task 41's `mediaUrl`-extended `sendSms` + Task 43's `GET /contact-card/:clientId`. The trigger point (right after sender authorization, before any expense/Step-5/Step-6 flow routing) and non-blocking/never-fails guarantee → Task 42's `maybeSendContactCard`, with its own try/catch and three dedicated test scenarios (success, send-failure, already-onboarded no-op). The `contact_card_sent_at` write-once-on-success/leave-null-on-failure behavior → Task 38's `markContactCardSent` + Task 42's usage of it, tested explicitly in scenario 27. The new `contact_card_intro` copy type going through the same `safeGenerateSmsCopy` pattern as everything else → Task 40 + Task 42's call site.

**Not yet in scope, intentionally (later Build Order step):** the onboarding CLI script (step 9) that actually creates the `clients`/`houses`/`authorized_senders` rows this step's logic operates on — this step only handles what happens the first time an already-provisioned sender texts in, exactly as scoped in the design spec.

**Placeholder scan:** No TBD/TODO markers. No new secrets or bindings were introduced — `DB`, `WORKER_BASE_URL`, and the Twilio secrets all already existed; Task 44 explicitly calls out that `wrangler.toml` needs no change this step, rather than silently omitting a step other Build Order steps have had.

**Type consistency:** `buildVCard({ businessName, phoneNumber })` (Task 39) is called with those exact field names, sourced from `client.business_name`/`client.twilio_number`, in Task 43's `handleGetContactCard` — no mismatch between the D1 column names and the function's parameter names. `sendSms`'s new `mediaUrl` parameter (Task 41) is optional and additive; every pre-existing call site (Step 7's `sendMonthlyNudges`) continues to omit it and is unaffected, verified by Task 41's own test asserting the earlier plain-SMS call in that same test file never gained a `MediaUrl` field. `maybeSendContactCard`'s `{ client, sender, fields, env, deps }` parameter shape matches the exact variable names already in scope at its call site inside `processExpenseMessage` — no renaming or repacking needed. `findClientById`/`markContactCardSent` (Task 38) are called with the same argument order in both their own tests and Task 42/43's usage.
