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
  const message = data?.choices?.[0]?.message?.content;
  if (typeof message !== 'string') {
    throw new Error('OpenRouter response missing choices[0].message.content');
  }
  return message;
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
