import { openRouterParseExpense, openRouterGenerateSmsCopy } from './openrouter.js';
import { anthropicParseExpense, anthropicGenerateSmsCopy } from './anthropic.js';

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
