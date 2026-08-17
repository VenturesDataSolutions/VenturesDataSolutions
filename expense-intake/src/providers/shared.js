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
    throw new ProviderParseError('extractJsonBlock expected a string');
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new ProviderParseError('No JSON object found in model response');
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    throw new ProviderParseError(`Model response contained a JSON-like block that failed to parse: ${err.message}`);
  }
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
