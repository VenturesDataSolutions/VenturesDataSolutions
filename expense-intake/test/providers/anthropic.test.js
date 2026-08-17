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
  assert(call.init.headers['anthropic-version'] === '2023-06-01', 'must send the pinned anthropic-version header value');
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
  assert(imageBody.messages[0].content[0].type === 'image', 'image block must precede the text block, per Anthropic\'s recommended content ordering');

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

  // parseExpense malformed 200 response (defensive guard)
  const malformedFetch = fakeFetch({ content: [] });
  let malformedThrew = false;
  try {
    await anthropicParseExpense({ apiKey: 'sk-ant-key', text: 'x', image: null, fetchImpl: malformedFetch });
  } catch (err) {
    malformedThrew = true;
    assert(err.message === 'Anthropic response missing content[0].text', 'must surface a clear error for a malformed 200 response, not a raw TypeError');
  }
  assert(malformedThrew, 'a malformed 200 Anthropic response must throw a clear error');

  // generateSmsCopy
  const smsFetch = fakeFetch(messagesResponse('$42.50 recorded under Materials for 123 Main St. 10-minute window if this needs a fix.'));
  const sms = await anthropicGenerateSmsCopy({ apiKey: 'sk-ant-key', type: 'confirmation', vars: { amount: '42.50', category: 'Materials', house: '123 Main St' }, fetchImpl: smsFetch });
  assert(sms === '$42.50 recorded under Materials for 123 Main St. 10-minute window if this needs a fix.', 'generateSmsCopy must return the trimmed model output');
  const smsBody = JSON.parse(smsFetch.calls[0].init.body);
  assert(smsBody.temperature > 0.5, 'SMS copy generation must use a nonzero temperature for wording variation');

  console.log('PASS: providers/anthropic.test.js');
}

await main();
