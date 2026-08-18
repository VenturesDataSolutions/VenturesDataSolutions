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
  assert(SMS_COPY_ANCHORS.house_selection_retry.length === 2, 'house_selection_retry must have 2 tone anchors');
  assert(SMS_COPY_ANCHORS.house_selection_giveup.length === 2, 'house_selection_giveup must have 2 tone anchors');
  assert(SMS_COPY_ANCHORS.correction_confirmed.length === 2, 'correction_confirmed must have 2 tone anchors');
  assert(SMS_COPY_ANCHORS.pending_item_prompt.length === 2, 'pending_item_prompt must have 2 tone anchors');
  assert(SMS_COPY_ANCHORS.pending_empty.length === 2, 'pending_empty must have 2 tone anchors');

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

  let threwMalformedJson = false;
  try {
    extractJsonBlock('Note: {see attached} Answer: {"vendor":"HD","amount":1,"category":"Other","confidence":0.5,"raw_text":"x"}');
  } catch (err) {
    threwMalformedJson = true;
    assert(err instanceof ProviderParseError, 'malformed JSON between braces must throw ProviderParseError specifically');
  }
  assert(threwMalformedJson, 'extractJsonBlock must throw when the brace-delimited content is not valid JSON');

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

  // buildSmsCopyPrompt must work for each of the three new Step 5 types too (reuses the
  // same generic machinery already exercised above for confirmation/house_selection/etc.)
  const retryPrompt = buildSmsCopyPrompt('house_selection_retry', { house_list: '123 Main St or the Duplex' });
  assert(retryPrompt.user.includes('house_list: 123 Main St or the Duplex'), 'house_selection_retry prompt must carry the actual house list value');
  const giveupPrompt = buildSmsCopyPrompt('house_selection_giveup', {});
  assert(giveupPrompt.system.includes('saved'), 'house_selection_giveup prompt must include its tone anchors');
  const correctionPrompt = buildSmsCopyPrompt('correction_confirmed', { house: '456 Oak Ave' });
  assert(correctionPrompt.user.includes('house: 456 Oak Ave'), 'correction_confirmed prompt must carry the actual house value');

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

  // buildSmsCopyPrompt must work for the two new Step 6 types too
  const pendingItemPrompt = buildSmsCopyPrompt('pending_item_prompt', { amount: '10.00', category: 'Materials', date: '2026-08-12' });
  assert(pendingItemPrompt.user.includes('amount: 10.00') && pendingItemPrompt.user.includes('date: 2026-08-12'), 'pending_item_prompt must carry the actual amount/date values');
  const pendingEmptyPrompt = buildSmsCopyPrompt('pending_empty', {});
  assert(pendingEmptyPrompt.system.includes('caught up') || pendingEmptyPrompt.system.includes('clear'), 'pending_empty prompt must include its tone anchors');

  console.log('PASS: providers/shared.test.js');
}

await main();
