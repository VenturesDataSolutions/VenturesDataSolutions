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
