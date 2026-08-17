import { PARSE_EXPENSE_SYSTEM_PROMPT, buildSmsCopyPrompt, extractJsonBlock, normalizeParseExpenseResult } from './shared.js';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';
const ANTHROPIC_MAX_TOKENS = 1024;

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
    body: JSON.stringify({ model: ANTHROPIC_MODEL, system, max_tokens: ANTHROPIC_MAX_TOKENS, temperature, messages }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.error && data.error.message) || `Anthropic request failed with status ${response.status}`;
    throw new Error(message);
  }
  const text = data?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('Anthropic response missing content[0].text');
  }
  return text;
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
