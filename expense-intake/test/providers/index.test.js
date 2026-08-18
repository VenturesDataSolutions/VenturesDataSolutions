// expense-intake/test/providers/index.test.js
import { parseExpense, generateSmsCopy, matchHouseFromReply } from '../../src/providers/index.js';

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
  assert(orFetch.calls[0].init.headers.Authorization === 'Bearer or_key', 'AI_PROVIDER=openrouter routing must use OPENROUTER_API_KEY');

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

  // A case/typo mismatch (e.g. 'Anthropic' instead of 'anthropic') must also fall back to OpenRouter, not throw or silently misroute
  const typoFetch = fakeFetch({ choices: [{ message: { content: parsedJson } }] });
  await parseExpense({ text: 'x', image: null }, {
    AI_PROVIDER: 'Anthropic', OPENROUTER_API_KEY: 'or_key', ANTHROPIC_API_KEY: 'ant_key',
  }, { fetchImpl: typoFetch });
  assert(typoFetch.calls[0].url === 'https://openrouter.ai/api/v1/chat/completions', 'a case/typo mismatch like "Anthropic" must fall back to OpenRouter, not silently route to Anthropic');

  // generateSmsCopy routes the same way
  const smsFetch = fakeFetch({ content: [{ type: 'text', text: 'Saved under Materials for 123 Main St.' }] });
  const sms = await generateSmsCopy('confirmation', { amount: '42.50', category: 'Materials', house: '123 Main St' }, {
    AI_PROVIDER: 'anthropic', OPENROUTER_API_KEY: 'or_key', ANTHROPIC_API_KEY: 'ant_key',
  }, { fetchImpl: smsFetch });
  assert(sms === 'Saved under Materials for 123 Main St.', 'generateSmsCopy must return the adapter output');
  assert(smsFetch.calls[0].url === 'https://api.anthropic.com/v1/messages', 'generateSmsCopy must route through the same AI_PROVIDER dispatch as parseExpense');

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

  console.log('PASS: providers/index.test.js');
}

await main();
