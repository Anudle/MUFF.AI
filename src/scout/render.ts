/**
 * MUFF-72 — layout for the scout, in code: a short Telegram message for the
 * pickups worth acting on, and one self-contained HTML page for the full
 * board. The page is written to a local file and is never uploaded — it
 * shows my roster's weak spots, which the league site must not.
 */

import type { Candidate, Scout } from "./types.ts";

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** Telegram's legacy Markdown: escape the four characters it treats as markup. */
const md = (s: string) => s.replace(/([_*`\[])/g, "\\$1");

const html = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function alertLine(c: Candidate): string {
  const who = `*${md(c.name)}* (${c.position}, ${md(c.nfl_team ?? "FA")})`;
  const season = c.season_points !== null ? `, ${c.season_points} season` : "";
  const versus =
    c.drop === null
      ? "you roster no one at the position"
      : `vs ${md(c.drop)}: ${c.drop_points ?? 0} pts` +
        (c.drop_season_points !== null ? `, ${c.drop_season_points} season` : "") +
        ` (${signed(c.week_gain)} this week)`;
  const status = c.status ? `\n   status: ${md(c.status)}` : "";
  return `${who}: ${c.points} pts${season}\n   ${versus}${status}`;
}

export function renderAlert(scout: Scout, alerts: Candidate[]): string {
  const head = `Scout, week ${scout.week}${scout.live ? " (in progress)" : ""}: ${alerts.length} free agent${alerts.length === 1 ? "" : "s"} worth a look`;
  const foot = scout.live
    ? "\n\nPoints are partial while games are on; a player of yours who has not played yet shows 0."
    : "";
  return `${head}\n\n${alerts.map(alertLine).join("\n\n")}${foot}`;
}

/** Plain-text board for the terminal. */
export function renderBoardText(scout: Scout): string {
  const lines = [
    `${scout.league} — week ${scout.week}${scout.live ? " (in progress)" : ""} — ${scout.team}`,
  ];
  for (const b of scout.board) {
    lines.push("", `${b.position}  (your weakest: ${b.drop ?? "none rostered"})`);
    if (b.candidates.length === 0) lines.push("  no free agents with points");
    for (const c of b.candidates) {
      lines.push(
        `  ${c.alert ? "!" : " "} ${c.name.padEnd(24)} ${(c.nfl_team ?? "").padEnd(4)} ` +
          `${String(c.points).padStart(3)} pts  ${String(c.season_points ?? "-").padStart(4)} season  ` +
          `${signed(c.week_gain).padStart(4)} wk  ${(c.season_gain === null ? "-" : signed(c.season_gain)).padStart(5)} season` +
          (c.status ? `  [${c.status}]` : ""),
      );
    }
  }
  return lines.join("\n");
}

export function renderBoardHtml(scout: Scout, asOf: string): string {
  const sections = scout.board
    .map((b) => {
      const rows = b.candidates
        .map(
          (c) => `<tr${c.alert ? ' class="alert"' : ""}>
<td>${html(c.name)}${c.status ? ` <small>${html(c.status)}</small>` : ""}</td>
<td>${html(c.nfl_team ?? "")}</td>
<td class="n">${c.points}</td>
<td class="n">${c.season_points ?? "–"}</td>
<td class="n">${signed(c.week_gain)}</td>
<td class="n">${c.season_gain === null ? "–" : signed(c.season_gain)}</td>
</tr>`,
        )
        .join("\n");
      return `<section>
<h2>${b.position}</h2>
<p>Your weakest: ${b.drop ? html(b.drop) : "none rostered"}</p>
<table>
<thead><tr><th>Free agent</th><th>Team</th><th class="n">Week</th><th class="n">Season</th><th class="n">Week gain</th><th class="n">Season gain</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="6">No free agents with points.</td></tr>'}
</tbody>
</table>
</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Scout — week ${scout.week}</title>
<style>
:root { color-scheme: light dark; --line: #8884; --hit: #2a9d4a22; }
body { font: 15px/1.45 system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
h1 { font-size: 1.4rem; margin-bottom: .2rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 .2rem; }
p { margin: 0 0 .5rem; opacity: .75; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); }
th { font-weight: 600; font-size: .85rem; }
.n { text-align: right; }
tr.alert { background: var(--hit); font-weight: 600; }
small { opacity: .7; font-weight: 400; }
</style>
</head>
<body>
<h1>Scout — week ${scout.week}${scout.live ? " (in progress)" : ""}</h1>
<p>${html(scout.team)} · ${html(scout.league)} · as of ${html(asOf)} · private, local only</p>
<p>Gains compare each free agent with your weakest player at the position (fewest season points). Highlighted rows cleared the alert bar.</p>
${sections}
</body>
</html>
`;
}
