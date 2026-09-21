/**
 * Team-name identity across the facts → model → render/history/eval loop.
 *
 * Team names are the join key everywhere downstream of the model: the eval's
 * rankings_complete check, the movement arrows in render.ts, and the
 * published-rankings history that next week's arrows read. The model does not
 * reliably echo them byte-for-byte — Yahoo sends "Tebow’s Purity Ring" (U+2019)
 * and Opus writes "Tebow's Purity Ring" (U+0027) — so raw string equality
 * silently breaks all three: the eval reports the team as both missing and
 * invented, and the arrows show 🆕 every week.
 *
 * Two layers, so old archives and the deployed history stay readable:
 *   - `canonicalizeTeams()` snaps the model's output back to the exact facts
 *     spelling right after the parse, so everything archived or persisted from
 *     here on carries the provider's bytes.
 *   - `teamKey()` is the comparison key for anything that reads names written
 *     before this existed (week-1 history in S3, archived runs under eval).
 *
 * Only typographic variants are folded; a genuinely different name still
 * fails the eval, which is the point of that check.
 */

import type { Digest } from "./generate.ts";

/** Equality key: typographic quotes/dashes → ASCII, NFKC, whitespace collapsed, case-folded. */
export function teamKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[‘’‚‛′´`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Rewrite every `team` in the digest's power rankings to the facts' exact spelling where the key matches. */
export function canonicalizeTeams(digest: Digest, leagueTeams: readonly string[]): Digest {
  const byKey = new Map(leagueTeams.map((t) => [teamKey(t), t]));
  return {
    ...digest,
    power_rankings: digest.power_rankings.map((p) => ({ ...p, team: byKey.get(teamKey(p.team)) ?? p.team })),
  };
}
