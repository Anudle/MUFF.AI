/**
 * MUFF-16 — synthetic digests that eval the eval.
 *
 * Until real season runs exist (kickoff is September), the checker has
 * nothing to score — so it scores digests we construct with known truth
 * values. `buildGroundedDigest` cites only numbers straight from the facts
 * and MUST pass every check; `corruptDigest` swaps one number for a value
 * that exists nowhere in the facts and MUST fail groundedness. If either
 * assertion breaks, the checker regressed — that pair is the regression
 * gate CI runs on every PR, no API key, no Yahoo.
 *
 * (CCA-F: a test harness is only trustworthy if a known-bad input fails it.
 * A groundedness checker that never flags anything looks identical to one
 * that works — until you feed it a hallucination on purpose.)
 */

import type { Digest } from "../digest/generate.ts";
import type { WeekFacts } from "../digest/facts.ts";

/** A deliberately boring digest where every cited number is a fact. */
export function buildGroundedDigest(facts: WeekFacts): Digest {
  const hi = facts.highest_scorer;
  const lo = facts.lowest_scorer;
  const bench = facts.bench_points[0];
  const under = facts.underachiever;
  if (!hi || !lo || !bench || !under) {
    throw new Error("Fixture is missing the superlatives the synthetic digest cites.");
  }

  return {
    headline: `Week ${facts.week}: ${hi.team} puts up ${hi.points}`,
    recap:
      `${hi.team} led the week with ${hi.points}.` +
      (facts.biggest_blowout
        ? ` ${facts.biggest_blowout.winner} beat ${facts.biggest_blowout.loser} by ${facts.biggest_blowout.margin}.`
        : ""),
    game_notes: facts.results.map((g) => {
      const [a, b] = g.teams;
      return `${a?.team} ${a?.points} — ${b?.points} ${b?.team}${g.is_tied ? " (tie)" : ""}`;
    }),
    trash_talk: [
      `${lo.team} managed ${lo.points} points, the floor of the week.`,
      `${bench.team} left ${bench.bench_points} points sitting on the bench.`,
      `${under.team} came in ${Math.abs(under.delta)} under projection.`,
    ],
    power_rankings: facts.standings.map((s, i) => ({
      rank: s.rank ?? i + 1,
      team: s.team,
      comment: `${s.record}, ${s.points_for} points for.`,
    })),
    waiver_watch: facts.recent_transactions.length > 0 ? "The wire stayed busy this week." : "",
  };
}

/**
 * Same digest, one hallucinated stat: the first number in the first roast is
 * replaced with a value guaranteed absent from `allowed`.
 */
export function corruptDigest(digest: Digest, allowed: Set<number>): Digest {
  let fake = 777.77;
  while (allowed.has(fake) || allowed.has(Math.round(fake * 10) / 10)) fake += 11.11;

  const line = digest.trash_talk[0];
  const match = line?.match(/\d+(?:\.\d+)?/);
  if (!line || !match) throw new Error("Synthetic digest has no number to corrupt.");

  return {
    ...digest,
    trash_talk: [line.replace(match[0], fake.toFixed(2)), ...digest.trash_talk.slice(1)],
  };
}
