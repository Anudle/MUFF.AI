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
  walk(facts);
  return allowed;
}

/** The model-authored strings of a digest, labeled for failure messages. */
function proseFields(d: Digest): [string, string][] {
  return [
    ["headline", d.headline],
    ["recap", d.recap],
    ...d.game_notes.map((n, i): [string, string] => [`game_notes[${i}]`, n]),
    ...d.trash_talk.map((t, i): [string, string] => [`trash_talk[${i}]`, t]),
    ...d.power_rankings.map((p, i): [string, string] => [`power_rankings[${i}].comment`, p.comment]),
    ["waiver_watch", d.waiver_watch],
  ];
}

export function evaluateRecord({ facts, digest, text }: EvalRecord): EvalReport {
  const checks: CheckResult[] = [];
  const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

  // --- groundedness ----------------------------------------------------------
  const allowed = collectFactNumbers(facts);
  const hallucinated: string[] = [];
  for (const [field, value] of proseFields(digest)) {
    for (const token of value.match(NUM_RE) ?? []) {
      if (!allowed.has(parseFloat(token))) hallucinated.push(`${field}: "${token}"`);
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
  check(
    "trash_talk_count",
    digest.trash_talk.length >= 3 && digest.trash_talk.length <= 5,
    `${digest.trash_talk.length} lines (want 3-5)`,
  );

  // Fresh non-global regex: .test() on a /g/ regex is stateful across calls.
  const numberless = digest.trash_talk.filter((t) => !/\d/.test(t));
  check(
    "trash_talk_cites_numbers",
    numberless.length === 0,
    numberless.length === 0
      ? "every roast quotes a stat"
      : `line(s) with no number at all: ${numberless.map((t) => JSON.stringify(t)).join(", ")}`,
  );

  check(
    "game_notes_count",
    digest.game_notes.length === facts.results.length,
    `${digest.game_notes.length} notes for ${facts.results.length} matchups`,
  );

  const rankedTeams = new Set(digest.power_rankings.map((p) => p.team));
  const leagueTeams = new Set(facts.standings.map((s) => s.team));
  const missing = [...leagueTeams].filter((t) => !rankedTeams.has(t));
  const unknown = [...rankedTeams].filter((t) => !leagueTeams.has(t));
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

  // A quiet wire must yield an empty waiver_watch — anything else is invented.
  check(
    "waiver_watch_grounded",
    facts.recent_transactions.length > 0 || digest.waiver_watch.trim() === "",
    facts.recent_transactions.length > 0
      ? `${facts.recent_transactions.length} transaction(s) available to talk about`
      : digest.waiver_watch.trim() === ""
        ? "no transactions, waiver watch correctly empty"
        : `no transactions in facts, yet waiver_watch says: ${JSON.stringify(digest.waiver_watch)}`,
  );

  // --- format: the rendered message ------------------------------------------
  check(
    "telegram_length",
    text.length > 0 && text.length <= TELEGRAM_MESSAGE_LIMIT,
    `${text.length} chars (limit ${TELEGRAM_MESSAGE_LIMIT})`,
  );

  return { pass: checks.every((c) => c.ok), checks };
}
