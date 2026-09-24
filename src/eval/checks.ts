/**
 * MUFF-16 — rule-based checks: the deterministic floor of the eval stack.
 *
 * The eval pyramid, cheapest layer first (CCA-F: evals): rule checks (this
 * file — free, exact, run on every PR) → LLM-as-judge for tone/quality (costs
 * a call, subjective, later) → humans (the group chat). A claim that fails
 * HERE never needs a judge: "cites a number that isn't in the facts" is not a
 * matter of taste.
 *
 * Groundedness is the flagship check. The digest prompt's core rule is that
 * every number the model writes exists in the facts JSON — this verifies it
 * mechanically: harvest every number a fact contains (including numbers
 * embedded in strings: records "5-2", streaks "W3", transaction summaries),
 * then demand every number in the model's prose appears in that set. Rounding
 * to 1 decimal is allowed (the prompt says so); anything else is a
 * hallucinated stat.
 *
 * Known looseness, accepted on purpose: any small integer that happens to be
 * a standings rank (1..N) is in the allowed set, so "3 touchdowns" slips
 * through as rank 3. Tightening that means classifying number *semantics*,
 * which is judge territory — the rule layer stays dumb and exact.
 */

import type { Digest } from "../digest/generate.ts";
import type { WeekFacts } from "../digest/facts.ts";
import { teamKey } from "../digest/team-names.ts";

/** What every check runs against: model input, model output, rendered message. */
export interface EvalRecord {
  facts: WeekFacts;
  digest: Digest;
  text: string;
}

export interface CheckResult {
  id: string;
  ok: boolean;
  detail: string;
}

export interface EvalReport {
  pass: boolean;
  checks: CheckResult[];
}

/** Telegram's hard per-message limit; sendMessage rejects anything longer. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

const NUM_RE = /\d+(?:\.\d+)?/g;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Spelled-out numbers the model might reach for ("beat five other teams").
 * The prompt forbids them, but a rule the checker cannot see is not a rule:
 * each word is scanned as its value (MUFF-60 punch list #2). "one" is left
 * out on purpose — as a pronoun/article it is everywhere, and 1 is always a
 * standings rank anyway.
 */
const NUMBER_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};
const NUMBER_WORD_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "gi");

/** Every numeric token in a prose string, digits and number words alike, as [token, value]. */
export function proseNumbers(text: string): [string, number][] {
  const digits = (text.match(NUM_RE) ?? []).map((t): [string, number] => [t, parseFloat(t)]);
  const words = (text.match(NUMBER_WORD_RE) ?? []).map((w): [string, number] => [w, NUMBER_WORDS[w.toLowerCase()]]);
  return [...digits, ...words];
}

/**
 * Every number a digest may legally cite: numeric fact values, numbers inside
 * fact strings, absolute values (prose says "24.14 under projection" for a
 * delta of -24.14), and 1-decimal roundings.
 */
export function collectFactNumbers(facts: WeekFacts): Set<number> {
  const allowed = new Set<number>();
  const add = (n: number) => {
    allowed.add(n);
    allowed.add(Math.abs(n));
    allowed.add(round1(Math.abs(n)));
  };
  const walk = (v: unknown): void => {
    if (typeof v === "number") add(v);
    else if (typeof v === "string") for (const m of v.match(NUM_RE) ?? []) add(parseFloat(m));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  // Provenance is metadata the model never sees (generate.ts strips it), so
  // its timestamp digits must not widen what counts as a grounded number.
  const { provenance: _provenance, ...cited } = facts;
  walk(cited);
  return allowed;
}

/** The model-authored strings of a digest, labeled for failure messages. */
function proseFields(d: Digest): [string, string][] {
  return [
    ["headline", d.headline],
    ["recap", d.recap],
    ...d.power_rankings.map((p, i): [string, string] => [`power_rankings[${i}].comment`, p.comment]),
  ];
}

export function evaluateRecord({ facts, digest, text }: EvalRecord): EvalReport {
  const checks: CheckResult[] = [];
  const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

  // --- groundedness ----------------------------------------------------------
  const allowed = collectFactNumbers(facts);
  const hallucinated: string[] = [];
  for (const [field, value] of proseFields(digest)) {
    for (const [token, n] of proseNumbers(value)) {
      if (!allowed.has(n)) hallucinated.push(`${field}: "${token}"`);
    }
  }
  check(
    "groundedness",
    hallucinated.length === 0,
    hallucinated.length === 0
      ? "every number in the prose appears in the facts"
      : `numbers with no source fact — ${hallucinated.join(", ")}`,
  );

  // --- format: counts and coverage -------------------------------------------
  // The recap is the only roast slot left (the digest was cut to headline +
  // recap + rankings), so it must quote at least one stat.
  check(
    "recap_cites_numbers",
    /\d/.test(digest.recap),
    /\d/.test(digest.recap) ? "recap quotes a stat" : "recap has no number at all",
  );

  // Compare by teamKey, not raw string: the model writes "Tebow's" for Yahoo's
  // "Tebow’s", and archived runs predate canonicalisation in generate.ts.
  const rankedTeams = new Set(digest.power_rankings.map((p) => teamKey(p.team)));
  const leagueTeams = new Set(facts.standings.map((s) => teamKey(s.team)));
  const missing = facts.standings.map((s) => s.team).filter((t) => !rankedTeams.has(teamKey(t)));
  const unknown = digest.power_rankings.map((p) => p.team).filter((t) => !leagueTeams.has(teamKey(t)));
  const ranks = digest.power_rankings.map((p) => p.rank).sort((a, b) => a - b);
  const ranksOk = ranks.every((r, i) => r === i + 1);
  check(
    "rankings_complete",
    missing.length === 0 && unknown.length === 0 && ranksOk,
    missing.length || unknown.length
      ? `missing: [${missing.join(", ")}] invented: [${unknown.join(", ")}]`
      : ranksOk
        ? `all ${leagueTeams.size} teams ranked 1-${leagueTeams.size}`
        : `ranks are not a permutation of 1-${leagueTeams.size}: ${ranks.join(",")}`,
  );

  // Movement arrows are computed in render.ts from published history — a model
  // that writes its own is inventing movement it cannot know.
  const arrowed = proseFields(digest).filter(([, v]) => /[▲▼]|🆕/.test(v));
  check(
    "arrows_belong_to_render",
    arrowed.length === 0,
    arrowed.length === 0
      ? "no model-authored movement arrows"
      : `arrows written by the model in: ${arrowed.map(([f]) => f).join(", ")}`,
  );

  // "Up from 7th" on a team now ranked 8th: the number is real, the direction
  // is wrong, and only a human would notice. Direction is arithmetic, so code
  // checks it — "up" means a smaller rank number now, "down" a larger one.
  const wrongWay = digest.power_rankings.flatMap((p) =>
    [...p.comment.matchAll(/\b(up|down) from (\d+)(?:st|nd|rd|th)\b/gi)]
      .filter(([, dir, was]) => (dir.toLowerCase() === "up" ? Number(was) <= p.rank : Number(was) >= p.rank))
      .map(([phrase]) => `${p.team} (now ${p.rank}): "${phrase}"`),
  );
  check(
    "movement_direction",
    wrongWay.length === 0,
    wrongWay.length === 0 ? "every up/down claim matches the rank" : `direction contradicts the rank — ${wrongWay.join(", ")}`,
  );

  // MUFF-40: receipts need a closed poll. Prose about votes with no
  // group_predictions in the facts is a poll the model made up.
  const pollTalk = proseFields(digest).filter(([, v]) => /%|\bvot(?:e|ed|es|ing)\b|\bpoll\b/i.test(v));
  check(
    "poll_receipts_grounded",
    facts.group_predictions != null || pollTalk.length === 0,
    facts.group_predictions != null
      ? `poll closed with ${facts.group_predictions.total_votes} vote(s), receipts allowed`
      : pollTalk.length === 0
        ? "no poll in facts, no poll talk in prose"
        : `no poll in facts, yet prose talks votes in: ${pollTalk.map(([f]) => f).join(", ")}`,
  );

  // --- format: the rendered message ------------------------------------------
  check(
    "telegram_length",
    text.length > 0 && text.length <= TELEGRAM_MESSAGE_LIMIT,
    `${text.length} chars (limit ${TELEGRAM_MESSAGE_LIMIT})`,
  );

  return { pass: checks.every((c) => c.ok), checks };
}
