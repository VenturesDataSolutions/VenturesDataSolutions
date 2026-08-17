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
