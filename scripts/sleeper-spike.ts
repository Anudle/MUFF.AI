/**
 * MUFF-49 spike — thin Sleeper client proving the provider swap is possible.
 *
 * Hits the live, zero-auth Sleeper API and reshapes the responses into the
 * exact envelopes our five MCP tools return today (docs/mcp-tools.md), so we
 * can see every gap before writing the real adapter. No SDK, no retries, no
 * cache invalidation — findings live in docs/sleeper-spike.md.
 *
 *   npm run spike:sleeper            # week 5 of the test league
 *   npm run spike:sleeper -- 11      # another week
 *
 * SLEEPER_LEAGUE_ID overrides the default public test league (Par-Laid Days,
 * 2025, 12-team superflex redraft — chosen because it has real transactions,
 * no best-ball, no league-median game).
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

const BASE = "https://api.sleeper.app/v1";
const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID ?? "1251080762300583936";
const week = Number(process.argv[2] ?? 5);

async function get(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Players map — the 14.6MB problem (docs said 5MB; it grew).
// Trimmed to id → {name, pos, team} it's ~760KB. Cached on disk for 24h;
// the real adapter will do the same trick against S3 (step 3 of MUFF-49).
// ---------------------------------------------------------------------------

type PlayerLite = { name: string; pos: string | null; team: string | null };
const PLAYERS_CACHE = ".cache/sleeper-players.json";

async function loadPlayers(): Promise<Record<string, PlayerLite>> {
  const fresh = await stat(PLAYERS_CACHE)
    .then((s) => Date.now() - s.mtimeMs < 24 * 60 * 60 * 1000)
    .catch(() => false);
  if (fresh) return JSON.parse(await readFile(PLAYERS_CACHE, "utf8"));

  console.log("fetching /players/nfl (one ~14.6MB call, cached 24h)…");
  const raw = await get("/players/nfl");
  const trimmed: Record<string, PlayerLite> = {};
  for (const [id, p] of Object.entries<any>(raw)) {
    trimmed[id] = {
      name: p.full_name ?? p.last_name ?? id, // team defenses have no full_name
      pos: p.position ?? null,
      team: p.team ?? null,
    };
  }
  await mkdir(".cache", { recursive: true });
  await writeFile(PLAYERS_CACHE, JSON.stringify(trimmed));
  return trimmed;
}

// ---------------------------------------------------------------------------
// Fetch everything the five tools need — five cheap calls + the players map
// ---------------------------------------------------------------------------

const [players, league, users, rosters, matchups, transactions] =
  await Promise.all([
    loadPlayers(),
    get(`/league/${LEAGUE_ID}`),
    get(`/league/${LEAGUE_ID}/users`),
    get(`/league/${LEAGUE_ID}/rosters`),
    get(`/league/${LEAGUE_ID}/matchups/${week}`),
    get(`/league/${LEAGUE_ID}/transactions/${week}`),
  ]);

// roster_id → display team name. Sleeper has no "team" entity: a roster
// belongs to a user, and the team name is user metadata (fallback: username).
const userById = new Map<string, any>(users.map((u: any) => [u.user_id, u]));
const teamName = new Map<number, string>(
  rosters.map((r: any) => {
    const u = userById.get(r.owner_id);
    return [r.roster_id, u?.metadata?.team_name ?? u?.display_name ?? `Roster ${r.roster_id}`];
  }),
);
const manager = new Map<number, string | null>(
  rosters.map((r: any) => [r.roster_id, userById.get(r.owner_id)?.display_name ?? null]),
);

const name = (id: string) => players[id]?.name ?? id;

console.log(`\n=== ${league.name} — season ${league.season}, week ${week} ===`);
console.log(`status: ${league.status} · ${league.settings.num_teams} teams · lineup: ${league.roster_positions.filter((p: string) => p !== "BN").join("/")}\n`);

// ---------------------------------------------------------------------------
// get_week_results — pair matchup entries by matchup_id, winner by points
// (Sleeper has no winner field; ties are equality)
// ---------------------------------------------------------------------------

const byMatchup = new Map<number, any[]>();
for (const m of matchups) {
  if (m.matchup_id == null) continue; // bye / eliminated in playoffs
  (byMatchup.get(m.matchup_id) ?? byMatchup.set(m.matchup_id, []).get(m.matchup_id)!).push(m);
}

console.log("— get_week_results —");
for (const [id, pair] of [...byMatchup].sort(([a], [b]) => a - b)) {
  const [a, b] = pair;
  const tied = b !== undefined && a.points === b.points;
  const winner = b === undefined || tied ? null : (a.points > b.points ? a : b);
  const line = pair
    .map((m: any) => `${teamName.get(m.roster_id)} ${m.points}`)
    .join("  vs  ");
  console.log(`  [${id}] ${line}${tied ? "  (TIE)" : winner ? `  → ${teamName.get(winner.roster_id)}` : ""}  (projected: null — gap)`);
}

// ---------------------------------------------------------------------------
// get_standings — no endpoint; derived from roster season settings.
// Gotcha: season points are split integer/decimal (fpts + fpts_decimal/100).
// Streak comes free in roster.metadata ("3L" → Yahoo-style "L3").
// ---------------------------------------------------------------------------

const standings = rosters
  .map((r: any) => {
    const s = r.settings;
    const streakRaw: string | undefined = r.metadata?.streak; // e.g. "3L"
    return {
      team: teamName.get(r.roster_id),
      manager: manager.get(r.roster_id),
      wins: s.wins, losses: s.losses, ties: s.ties,
      points_for: s.fpts + (s.fpts_decimal ?? 0) / 100,
      points_against: (s.fpts_against ?? 0) + (s.fpts_against_decimal ?? 0) / 100,
      streak: streakRaw ? `${streakRaw.at(-1)}${streakRaw.slice(0, -1)}` : null,
    };
  })
  .sort((a: any, b: any) => b.wins - a.wins || b.points_for - a.points_for);

console.log("\n— get_standings (derived: sort by wins, then points-for) —");
standings.forEach((s: any, i: number) =>
  console.log(`  ${String(i + 1).padStart(2)}. ${s.team} (${s.manager})  ${s.wins}-${s.losses}${s.ties ? `-${s.ties}` : ""}  PF ${s.points_for.toFixed(2)}  ${s.streak ?? ""}`),
);

// ---------------------------------------------------------------------------
// get_roster / league rosters — matchup entries carry players, starters, and
// per-player points for the week. Better than Yahoo: one call covers ALL teams.
// ---------------------------------------------------------------------------

console.log("\n— get_roster shape (first team, from the SAME matchups call) —");
const m0 = matchups[0];
const starters = new Set<string>(m0.starters);
for (const pid of m0.players.slice(0, 18)) {
  const slot = starters.has(pid) ? "started" : "BN";
  console.log(`  ${name(pid).padEnd(24)} ${(players[pid]?.pos ?? "?").padEnd(4)} ${slot.padEnd(8)} ${m0.players_points[pid] ?? 0} pts`);
}
const benchPts = m0.players
  .filter((pid: string) => !starters.has(pid))
  .reduce((sum: number, pid: string) => sum + (m0.players_points[pid] ?? 0), 0);
console.log(`  → bench points for ${teamName.get(m0.roster_id)}: ${benchPts.toFixed(2)} (digest fact, no extra calls)`);

// ---------------------------------------------------------------------------
// get_transactions — adds/drops are {player_id: roster_id} maps
// ---------------------------------------------------------------------------

console.log(`\n— get_transactions (week ${week}: ${transactions.length}) —`);
for (const t of transactions.slice(0, 6)) {
  const moves = [
    ...Object.entries(t.adds ?? {}).map(([pid, rid]) => `${name(pid)} add → ${teamName.get(rid as number)}`),
    ...Object.entries(t.drops ?? {}).map(([pid, rid]) => `${name(pid)} drop ← ${teamName.get(rid as number)}`),
  ].join("; ");
  console.log(`  ${t.type} (${t.status}) ${new Date(t.created).toISOString().slice(0, 10)}: ${moves || "(no player moves)"}`);
}

console.log("\nSpike complete — mapping + gaps documented in docs/sleeper-spike.md");
