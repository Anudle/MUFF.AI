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
import { priceRun, type RunCost } from "./cost.ts";
import type { WeekFacts } from "./facts.ts";
import { canonicalizeTeams } from "./team-names.ts";

const MODEL = "claude-opus-4-8";

export const DigestSchema = z.object({
  headline: z.string().describe("One punchy line for the top of the digest."),
  recap: z
    .string()
    .describe(
      "3-5 sentences, the whole story of the week: who won, who choked, the one roast that deserves a screenshot (bench points, margin or projection miss, with the exact number).",
    ),
  power_rankings: z.array(
    z.object({
      rank: z.number().int(),
      team: z.string().describe("The team name exactly as it appears in the facts — nothing else in this field."),
      comment: z.string().describe("Short, opinionated, references record or points."),
    }),
  ),
});

export type Digest = z.infer<typeof DigestSchema>;

/**
 * League name and size come from the facts, not the prompt (MUFF-60 punch
 * list #3): a hard-coded "Monarch United / twelve friends" would have called a
 * 14-team dry-run mock by the real league's name and nobody would have known.
 */
export function systemPrompt(facts: Pick<WeekFacts, "league" | "standings">): string {
  return `You write the Tuesday-morning digest for the "${facts.league}" fantasy football league group chat. ${facts.standings.length} friends, heavy trash-talk culture, everyone reads it on their phone.

Rules:
- GROUNDING IS EVERYTHING. Every roast, every claim, every ranking comment must be backed by an exact number present in the facts JSON. Never invent, round beyond 1 decimal, or extrapolate stats.
- NEVER DO ARITHMETIC. Do not subtract, add, or compare two facts to produce a new number ("lost by 39", "15.9 short"). Only cite margins, deltas, and totals the facts already publish. A correct number you computed yourself is still a violation.
- Write every number as digits (5, not "five"; 100, not "a hundred") so each stat can be traced to the facts.
- Cite numbers, not field names: "beat projection by 38", never "a delta of 38" or "a margin of 52". The reader sees a sentence, not the JSON.
- Use team names exactly as given; use manager first names when available for the personal touch.
- Roast performances, not people. Confident, funny, quotable — the goal is screenshots.
- SHORT. The digest is headline + recap + power rankings, nothing else: it must read in one scroll on a phone. The recap carries the week's story and its best roast; the ranking comments are where everyone else gets theirs, one line each. No filler, no recapping every game.
- Power rankings: all teams, ordered by your read of record + points-for + trajectory (streak). Ranking opinions are yours; the numbers you cite must be real.
- Ranking comments may only cite numbers the facts publish for that team: record, points_for, streak, this week's score and margin, bench points, and the week's superlatives (highest/lowest scorer, closest game, biggest blowout, over/underachiever, worst start/sit). If the facts don't publish a team's projection delta, it has none — do not compute one.
- Whole numbers stay whole and decimals keep their decimal: 156.42 is "156.42", never "156".
- If previous_power_rankings is present, treat it as what you published last week: rank with fresh eyes, but call out notable risers/fallers in comments using exact previous positions ("up from 7th"). Only mention a previous position if the rank actually changed. Movement arrows are added automatically — don't write arrow symbols yourself.
- No preamble, no meta-commentary. Fill the schema.`;
}

/**
 * MUFF-16: the call reports what it cost. Token usage is only available on
 * the response object, so pricing happens here — at the one place that knows
 * both the model and the usage — rather than being re-derived downstream.
 */
export interface GeneratedDigest {
  digest: Digest;
  cost: RunCost;
}

export async function generateDigest(facts: WeekFacts): Promise<GeneratedDigest> {
  const client = new Anthropic();
  // Provenance (MUFF-58) is for the archive and the log, not the prose: the
  // league must not be able to tell a transcribed week from an API week, and
  // a timestamp is a bag of numbers the model must not be tempted to cite.
  const { provenance: _provenance, ...cited } = facts;
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: systemPrompt(facts),
    messages: [
      {
        role: "user",
        content: `Facts for ${facts.league}, week ${facts.week} (${facts.season} season):\n\n${JSON.stringify(cited, null, 1)}`,
      },
    ],
    output_config: { format: zodOutputFormat(DigestSchema) },
  });
  if (!response.parsed_output) {
    throw new Error(`Digest generation returned no parseable output (stop_reason: ${response.stop_reason})`);
  }
  // response.model is what actually served the request — prefer it over the
  // requested id so an alias or server-side reroute prices correctly.
  // Snap team names back to the facts' exact bytes (see team-names.ts): the
  // model normalises typography (’ → ') and every downstream join is by name.
  const digest = canonicalizeTeams(response.parsed_output, facts.standings.map((s) => s.team));
  return { digest, cost: priceRun(response.model ?? MODEL, response.usage) };
}
