import { openRouterParseExpense, openRouterGenerateSmsCopy, openRouterMatchHouseFromReply } from '../../src/providers/openrouter.js';

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

  // parseExpense malformed-200 path (missing choices/message/content)
  const malformedFetch = fakeFetch({ choices: [] });
  let malformedThrew = false;
  try {
    await openRouterParseExpense({ apiKey: 'or_key', text: 'x', image: null, fetchImpl: malformedFetch });
  } catch (err) {
    malformedThrew = true;
    assert(err.message === 'OpenRouter response missing choices[0].message.content', 'must surface a clear error for a malformed 200 response, not a raw TypeError');
  }
  assert(malformedThrew, 'a 200 response missing choices[0].message.content must throw');

  // generateSmsCopy
  const smsFetch = fakeFetch(chatResponse('$42.50 recorded under Materials for 123 Main St. 10-minute window if this needs a fix.'));
  const sms = await openRouterGenerateSmsCopy({ apiKey: 'or_key', type: 'confirmation', vars: { amount: '42.50', category: 'Materials', house: '123 Main St' }, fetchImpl: smsFetch });
  assert(sms === '$42.50 recorded under Materials for 123 Main St. 10-minute window if this needs a fix.', 'generateSmsCopy must return the trimmed model output');
  const smsBody = JSON.parse(smsFetch.calls[0].init.body);
  assert(smsBody.temperature > 0.5, 'SMS copy generation must use a nonzero temperature for wording variation');

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

  console.log('PASS: providers/openrouter.test.js');
}

await main();
