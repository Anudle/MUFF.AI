/**
 * MUFF-38 — digest generation: one structured-output call.
 *
 * CCA-F: structured outputs. The schema guarantees the SHAPE (sections,
 * counts, field types) so rendering never breaks; the prompt guarantees the
 * GROUNDING (every claim cites a number from the facts). Shape enforcement
 * belongs to the schema, content rules belong to the prompt — different
 * layers, different tools.
 *
 * Model: claude-opus-4-8. This is the flagship output, it runs once a week,
 * and the whole run costs cents — quality is worth infinitely more than the
 * tier discount here. (Tiering table: docs/agent-design.md.)
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { WeekFacts } from "./facts.ts";

export const DigestSchema = z.object({
  headline: z.string().describe("One punchy line for the top of the digest."),
  recap: z
    .string()
    .describe("2-4 sentence narrative of the week: who won, who choked, what mattered."),
  game_notes: z
    .array(z.string())
    .describe("One line per matchup, score included, snappy."),
  trash_talk: z
    .array(z.string())
    .describe(
      "3-5 roast lines. Each MUST quote at least one exact number from the facts (bench points, margin, projection miss).",
    ),
  power_rankings: z.array(
    z.object({
      rank: z.number().int(),
      team: z.string(),
      comment: z.string().describe("Short, opinionated, references record or points."),
    }),
  ),
  waiver_watch: z
    .string()
    .describe("1-2 sentences on notable adds/drops, or an empty string if nothing notable."),
});

export type Digest = z.infer<typeof DigestSchema>;

const SYSTEM = `You write the Tuesday-morning digest for the "Monarch United" fantasy football league group chat. Twelve friends, heavy trash-talk culture, everyone reads it on their phone.

Rules:
- GROUNDING IS EVERYTHING. Every roast, every claim, every ranking comment must be backed by an exact number present in the facts JSON. Never invent, round beyond 1 decimal, or extrapolate stats.
- Use team names as given; use manager first names when available for the personal touch.
- Roast performances, not people. Confident, funny, quotable — the goal is screenshots.
- Power rankings: all teams, ordered by your read of record + points-for + trajectory (streak). Ranking opinions are yours; the numbers you cite must be real.
- If previous_power_rankings is present, treat it as what you published last week: rank with fresh eyes, but call out notable risers/fallers in comments using exact previous positions ("up from 7th"). Only mention a previous position if the rank actually changed. Movement arrows are added automatically — don't write arrow symbols yourself.
- No preamble, no meta-commentary. Fill the schema.`;

export async function generateDigest(facts: WeekFacts): Promise<Digest> {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Facts for ${facts.league}, week ${facts.week} (${facts.season} season):\n\n${JSON.stringify(facts, null, 1)}`,
      },
    ],
    output_config: { format: zodOutputFormat(DigestSchema) },
  });
  if (!response.parsed_output) {
    throw new Error(`Digest generation returned no parseable output (stop_reason: ${response.stop_reason})`);
  }
  return response.parsed_output;
}
