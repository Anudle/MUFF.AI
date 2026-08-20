/**
 * MUFF-16 — what a digest run costs, in dollars.
 *
 * KR1 asks for "cost-per-run logged" across a season, which means turning the
 * API's token counts into money at the point of the call — not reconstructing
 * it from a billing page in December. Rates are per million tokens, first-party
 * Anthropic API pricing (docs.anthropic.com/en/docs/about-claude/pricing).
 *
 * Cache multipliers are relative to the input rate: a cache WRITE costs 1.25x
 * input, a cache READ costs 0.1x. The digest doesn't cache today (one call, no
 * repeated prefix) so both are zero — they're here so the number stays honest
 * if caching ever gets switched on.
 */

import type Anthropic from "@anthropic-ai/sdk";

/** USD per million tokens. */
const RATES: Record<string, { input: number; output: number }> = {
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export interface RunCost {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  /** null when the model isn't in RATES — tokens still recorded, price unknown. */
  cost_usd: number | null;
}

export function priceRun(model: string, usage: Anthropic.Usage): RunCost {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  const rate = RATES[model];
  const cost = rate
    ? ((input + cacheWrite * CACHE_WRITE_MULTIPLIER + cacheRead * CACHE_READ_MULTIPLIER) *
        rate.input +
        output * rate.output) /
      1_000_000
    : null;

  return {
    model,
    input_tokens: input,
    output_tokens: output,
    cache_write_tokens: cacheWrite,
    cache_read_tokens: cacheRead,
    // Sub-cent runs matter here — a season is ~18 of them against a $25 balance.
    cost_usd: cost === null ? null : Number(cost.toFixed(6)),
  };
}

export function formatCost(cost: RunCost): string {
  const total = cost.cost_usd === null ? "unpriced model" : `$${cost.cost_usd.toFixed(4)}`;
  return `${total} (${cost.input_tokens} in / ${cost.output_tokens} out, ${cost.model})`;
}
