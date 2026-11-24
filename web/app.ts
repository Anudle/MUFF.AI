/**
 * MUFF-71 — the league site. Draws one season snapshot (season.json); the
 * only arithmetic done here is the playoff simulation, because the what-if
 * picker has to re-run it on every tap (src/site/sim.ts, shared with tests).
 * The bracket is not simulated: it is today's standings plus the picks, seeded
 * by the same comparator (seedings, also in sim.ts). The recap and power
 * rankings are the delivered digest, drawn as written.
 * No framework: a handful of sections of DOM, rebuilt from state.
 */

import { pickKey, seedings, simulate, type Picks, type TeamOdds } from "../src/site/sim.ts";
import type { SeasonSnapshot } from "../src/site/types.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  node.append(...children);
  return node;
}

const record = (w: number, l: number, t: number) => `${w}-${l}${t ? `-${t}` : ""}`;
const pct = (p: number) => (p > 0 && p < 0.005 ? "<1%" : p < 1 && p > 0.995 ? ">99%" : `${Math.round(p * 100)}%`);
const signed = (n: number, digits = 1) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}`;

const ME_KEY = "muff.me";
function loadMe(): string {
  try {
    return localStorage.getItem(ME_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveMe(team: string) {
  try {
    localStorage.setItem(ME_KEY, team);
  } catch {
    /* private mode: the choice just doesn't persist */
  }
}

async function main() {
  const res = await fetch("season.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`season.json: ${res.status}`);
  const snap = (await res.json()) as SeasonSnapshot;
  const teams = snap.teams;
  const spots = snap.config.playoff_teams;
  const gamesLeft = snap.remaining.reduce((n, wk) => n + wk.matchups.length, 0);

  const baseline = simulate(snap);
  let picks: Picks = {};
  let odds: TeamOdds[] = baseline;
  let me = teams.findIndex((t) => t.team === loadMe());

  $("league").textContent = `${snap.league} · ${snap.season}`;
  $("asof").textContent =
    gamesLeft > 0
      ? `Through week ${snap.through_week}. ${spots} of ${teams.length} teams make it, with ${snap.config.regular_season_end - snap.through_week} weeks to play.`
      : `Regular season complete. The top ${spots} are in.`;
  $("foot").textContent = `Through week ${snap.through_week} · updated ${new Date(snap.generated_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

  const select = $<HTMLSelectElement>("me");
  for (const t of [...teams].sort((a, b) => a.team.localeCompare(b.team))) {
    const opt = el("option", { text: t.manager ? `${t.team} (${t.manager})` : t.team });
    opt.value = t.team;
    select.append(opt);
  }
  if (me >= 0) select.value = teams[me].team;
  select.addEventListener("change", () => {
    me = teams.findIndex((t) => t.team === select.value);
    saveMe(select.value);
    render();
  });

  $("reset").addEventListener("click", () => {
    picks = {};
    odds = baseline;
    render();
  });

  function setPick(week: number, m: number, team: number) {
    const key = pickKey(week, m);
    if (picks[key] === team) delete picks[key];
    else picks[key] = team;
    odds = Object.keys(picks).length ? simulate(snap, picks) : baseline;
    render();
  }

  function delta(i: number): HTMLElement | null {
    const d = Math.round((odds[i].playoff - baseline[i].playoff) * 100);
    if (!d) return null;
    return el("small", { class: `num ${d > 0 ? "up" : "down"}`, text: `${d > 0 ? "▲" : "▼"} ${Math.abs(d)}` });
  }

  function renderSticky() {
    const bar = $("sticky");
    bar.hidden = me < 0;
    if (me < 0) return;
    const d = delta(me);
    bar.replaceChildren(
      el("span", { text: `${teams[me].team}: ` }),
      el("b", { text: pct(odds[me].playoff) }),
      el("span", { text: gamesLeft > 0 ? " to make the playoffs " : " " }),
      ...(d ? [d] : []),
    );
  }

  function renderOdds() {
    const n = Object.keys(picks).length;
    $("odds-note").textContent = n
      ? `With your ${n} pick${n === 1 ? "" : "s"}. Arrows show the change from today's odds, in points.`
      : "Chance of finishing in the top " + spots + ", in today's standings order.";
    const rows: HTMLElement[] = [];
    teams.forEach((t, i) => {
      if (i === spots) rows.push(el("div", { class: "cut", text: "playoff line" }));
      const fill = el("div", { class: "fill" });
      fill.style.width = `${Math.max(odds[i].playoff * 100, odds[i].playoff > 0 ? 1.5 : 0)}%`;
      const d = delta(i);
      const row = el("div", { class: `odds-row${i === me ? " me" : ""}` }, [
        el("div", { class: "odds-name" }, [t.team, el("small", { class: "num", text: record(t.wins, t.losses, t.ties) })]),
        el("div", { class: "odds-val num" }, [pct(odds[i].playoff), ...(d ? [d] : [])]),
        el("div", { class: "track" }, [fill]),
      ]);
      row.title = `${t.team}: ${pct(odds[i].playoff)} playoff odds, about ${odds[i].avg_wins.toFixed(1)} wins, average seed ${odds[i].avg_seed.toFixed(1)}`;
      rows.push(row);
    });
    $("odds").replaceChildren(...rows);
  }

  const openWeeks = new Set<number>(snap.remaining.slice(0, 1).map((w) => w.week));
  function renderWhatIf() {
    $("whatif-section").hidden = gamesLeft === 0;
    $<HTMLButtonElement>("reset").disabled = Object.keys(picks).length === 0;
    const blocks = snap.remaining.map((wk) => {
      const picked = wk.matchups.filter((_, m) => picks[pickKey(wk.week, m)] !== undefined).length;
      const details = el("details", {}, [
        el("summary", {}, [`Week ${wk.week}`, el("small", { text: picked ? `${picked} picked` : `${wk.matchups.length} games` })]),
        ...wk.matchups.map(([a, b], m) => {
          const chosen = picks[pickKey(wk.week, m)];
          const button = (team: number) => {
            const btn = el("button", { class: `pick${chosen !== undefined && chosen !== team ? " lost" : ""}`, text: teams[team].team });
            btn.type = "button";
            btn.setAttribute("aria-pressed", String(chosen === team));
            btn.setAttribute("aria-label", `${teams[team].team} beats ${teams[team === a ? b : a].team} in week ${wk.week}`);
            btn.addEventListener("click", () => setPick(wk.week, m, team));
            return btn;
          };
          return el("div", { class: "game" }, [button(a), button(b)]);
        }),
      ]);
      details.open = openWeeks.has(wk.week);
      details.addEventListener("toggle", () => {
        if (details.open) openWeeks.add(wk.week);
        else openWeeks.delete(wk.week);
      });
      return details;
    });
    $("whatif").replaceChildren(...blocks);
  }

  function renderLuck() {
    const max = Math.max(1, ...teams.map((t) => Math.abs(t.luck)));
    const rows = teams
      .map((t, i) => ({ t, i }))
      .sort((a, b) => b.t.luck - a.t.luck)
      .map(({ t, i }) => {
        const bar = el("i", { class: t.luck >= 0 ? "pos" : "neg" });
        bar.style.width = `${(Math.abs(t.luck) / max) * 50}%`;
        const row = el("div", { class: `luck-row${i === me ? " me" : ""}` }, [
          el("div", { class: "luck-name" }, [
            t.team,
            el("small", { class: "num", text: `${record(t.wins, t.losses, t.ties)} · all-play ${record(t.all_play.wins, t.all_play.losses, t.all_play.ties)}` }),
          ]),
          el("div", { class: "div" }, [bar]),
          el("div", { class: "luck-val num", text: signed(t.luck) }),
        ]);
        row.title = `${t.team}: ${t.wins + t.ties / 2} wins, ${t.expected_wins.toFixed(1)} expected from their scores`;
        return row;
      });
    $("luck").replaceChildren(...rows);
  }

  /** Seed numbers in bracket order for a power-of-two field: 8 → 1,8,4,5,2,7,3,6. */
  function bracketOrder(size: number): number[] {
    let seeds = [1];
    while (seeds.length < size) seeds = seeds.flatMap((s) => [s, seeds.length * 2 + 1 - s]);
    return seeds;
  }

  const baseField = new Set(seedings(snap).order.slice(0, spots));
  function renderBracket() {
    const s = seedings(snap, picks);
    const n = Object.keys(picks).length;
    const firstWeek = snap.config.regular_season_end + 1;
    $("bracket-note").textContent =
      gamesLeft === 0
        ? `The regular season is over. This is the week ${firstWeek} bracket.`
        : n === 0
          ? "Who would play whom if the regular season ended today. Pick winners above to move it."
          : `Today's standings plus your ${n} pick${n === 1 ? "" : "s"}.` +
            (s.unpicked ? ` The ${s.unpicked} game${s.unpicked === 1 ? "" : "s"} you haven't picked ${s.unpicked === 1 ? "isn't" : "aren't"} counted.` : "");

    const slot = (seed: number) => {
      const i = s.order[seed - 1];
      return el("div", { class: `slot${i === me ? " me" : ""}` }, [
        el("span", { class: "seed num", text: String(seed) }),
        el("span", { class: "slot-name", text: teams[i].team }),
        ...(baseField.has(i) || seed > spots ? [] : [el("small", { class: "up", text: "in" })]),
        el("small", { class: "num", text: record(s.wins[i], s.losses[i], s.ties[i]) }),
      ]);
    };

    const blocks: HTMLElement[] = [];
    const isBracket = spots >= 2 && (spots & (spots - 1)) === 0 && spots <= teams.length;
    if (isBracket) {
      const seeds = bracketOrder(spots);
      const games: HTMLElement[] = [];
      for (let g = 0; g < seeds.length; g += 2) games.push(el("div", { class: "tie" }, [slot(seeds[g]), slot(seeds[g + 1])]));
      if (spots >= 4) {
        const rounds = Math.log2(spots);
        const next = rounds === 2 ? "Final" : rounds === 3 ? "Semifinal" : "Next round";
        blocks.push(el("p", { class: "round", text: `${rounds === 3 ? "Quarterfinals" : rounds === 2 ? "Semifinals" : "First round"} · week ${firstWeek}` }));
        for (let g = 0; g < games.length; g += 2) {
          blocks.push(
            el("div", { class: "half" }, [
              el("div", { class: "ties" }, [games[g], games[g + 1]]),
              el("div", { class: "next" }, [el("b", { text: next }), el("span", { text: `week ${firstWeek + 1}` }), el("span", { text: "winners meet" })]),
            ]),
          );
        }
        if (rounds === 3) blocks.push(el("p", { class: "round", text: `Final · week ${firstWeek + 2}` }));
      } else {
        blocks.push(el("p", { class: "round", text: `Final · week ${firstWeek}` }), ...games);
      }
    } else {
      blocks.push(...s.order.slice(0, spots).map((_, k) => slot(k + 1)));
    }
    const out = s.order.slice(spots, spots + 2);
    if (out.length) {
      blocks.push(el("p", { class: "round", text: "First out" }), el("div", { class: "tie outside" }, out.map((_, k) => slot(spots + k + 1))));
    }
    $("bracket").replaceChildren(...blocks);
  }

  function renderDigest() {
    const d = snap.digest;
    $("recap-section").hidden = !d;
    $("rankings-section").hidden = !d || d.power_rankings.length === 0;
    if (!d) return;
    $("h-recap").textContent = `Week ${d.week} recap`;
    $("recap-headline").textContent = d.headline;
    $("recap").textContent = d.recap;
    const moved = d.power_rankings.some((p) => p.prev_rank !== null);
    $("rankings-note").textContent = `After week ${d.week}, as posted in the group.${moved ? " Arrows are the change from last week." : ""}`;
    $("rankings").replaceChildren(
      ...d.power_rankings.map((p) => {
        const delta = p.prev_rank === null ? null : p.prev_rank - p.rank;
        const move =
          !moved ? null
          : delta === null ? el("small", { class: "move", text: "new" })
          : delta === 0 ? el("small", { class: "move", text: "—" })
          : el("small", { class: `move num ${delta > 0 ? "up" : "down"}`, text: `${delta > 0 ? "▲" : "▼"}${Math.abs(delta)}` });
        return el("li", { class: me >= 0 && teams[me].team === p.team ? "me" : "" }, [
          el("span", { class: "rank num", text: String(p.rank) }),
          el("div", { class: "rank-body" }, [
            el("b", {}, [p.team, ...(move ? [" ", move] : [])]),
            el("p", { text: p.comment }),
          ]),
        ]);
      }),
    );
  }

  /** Remaining opponents per team, as indexes into `teams`, in week order. */
  const opponents: number[][] = teams.map(() => []);
  for (const wk of snap.remaining) {
    for (const [a, b] of wk.matchups) {
      opponents[a].push(b);
      opponents[b].push(a);
    }
  }

  function renderRoad() {
    // A snapshot written before this section existed has no `road`; hide it.
    const rows = teams.map((t, i) => ({ t, i, road: t.road ?? null })).filter((x) => x.road !== null);
    $("road-section").hidden = rows.length === 0;
    if (rows.length === 0) return;
    const max = Math.max(1, ...rows.map((x) => Math.abs(x.road!.vs_league)));
    $("road-note").textContent =
      "Points per game scored by each team's remaining opponents, compared with the league average. Easiest run-in first.";
    $("road").replaceChildren(
      ...rows
        .sort((a, b) => a.road!.vs_league - b.road!.vs_league)
        .map(({ t, i, road }) => {
          const easier = road!.vs_league <= 0;
          // Easier runs left in blue, harder runs right in red (the luck rows' sides, recoloured in CSS).
          const bar = el("i", { class: easier ? "neg" : "pos" });
          bar.style.width = `${(Math.abs(road!.vs_league) / max) * 50}%`;
          const row = el("div", { class: `luck-row road-row${i === me ? " me" : ""}` }, [
            el("div", { class: "luck-name", text: t.team }),
            el("div", { class: "div" }, [bar]),
            el("div", { class: "luck-val num", text: `${Math.abs(road!.vs_league).toFixed(1)} ${easier ? "easier" : "harder"}` }),
            el("small", { class: "road-opp", text: `vs ${opponents[i].map((o) => teams[o].team).join(", ")}` }),
          ]);
          row.title = `${t.team}: remaining opponents average ${road!.opp_avg.toFixed(1)} points a game`;
          return row;
        }),
    );
  }

  function render() {
    renderSticky();
    renderOdds();
    renderWhatIf();
    renderBracket();
    renderDigest();
    renderLuck();
    renderRoad();
  }

  render();
  $("main").hidden = false;
}

main().catch((e) => {
  $("asof").textContent = "Couldn't load the season. Try again in a minute.";
  console.error(e);
});
