/**
 * MUFF-71 — the league site. Draws one season snapshot (season.json); the
 * only arithmetic done here is the playoff simulation, because the what-if
 * picker has to re-run it on every tap (src/site/sim.ts, shared with tests).
 * No framework: four sections of DOM, rebuilt from state.
 */

import { pickKey, simulate, type Picks, type TeamOdds } from "../src/site/sim.ts";
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

/** Sequential blue, light → dark (reversed on a dark surface so "few" recedes). */
const RAMP = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"];
const dark = matchMedia("(prefers-color-scheme: dark)");

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
  let swapSel: [number, number] | null = null;

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
    swapSel = null;
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

  function renderSwap() {
    const games = snap.through_week ? teams[0].scores.length : 0;
    const flat = snap.swap.flat();
    const lo = Math.min(...flat), hi = Math.max(...flat);
    const ramp = dark.matches ? [...RAMP].reverse() : RAMP;
    const step = (v: number) => (hi === lo ? 6 : Math.round(((v - lo) / (hi - lo)) * (RAMP.length - 1)));
    const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
    const asRecord = (v: number) => `${fmt(v)}-${fmt(games - v)}`;

    const head = el("tr", {}, [el("th"), ...teams.map((t, j) => {
      const th = el("th", { text: String(j + 1) });
      th.scope = "col";
      th.title = `${t.team}'s schedule`;
      return th;
    })]);
    const body = teams.map((t, i) => {
      const th = el("th", {}, [el("b", { text: String(i + 1) }), t.team]);
      th.scope = "row";
      const tr = el("tr", { class: i === me ? "me" : "" }, [
        th,
        ...snap.swap[i].map((v, j) => {
          const s = step(v);
          const btn = el("button", { text: fmt(v) });
          btn.type = "button";
          btn.style.background = ramp[s];
          // Ink flips at the ramp's midpoint, in whichever direction the ramp runs.
          const onDarkFill = dark.matches ? s <= 6 : s >= 6;
          btn.style.color = onDarkFill ? "#fff" : "#0b0b0b";
          btn.setAttribute("aria-label", i === j ? `${t.team}, real record ${asRecord(v)}` : `${t.team} with ${teams[j].team}'s schedule: ${asRecord(v)}`);
          btn.addEventListener("click", () => {
            swapSel = [i, j];
            renderSwap();
          });
          const sel = swapSel && swapSel[0] === i && swapSel[1] === j;
          return el("td", { class: `${i === j ? "real" : ""}${sel ? " sel" : ""}` }, [btn]);
        }),
      ]);
      return tr;
    });
    $("swap").replaceChildren(el("thead", {}, [head]), el("tbody", {}, body));

    const detail = $("swap-detail");
    const focus = swapSel ? swapSel[0] : me;
    if (focus < 0) {
      detail.textContent = "Pick your team at the top to see your best and worst case.";
      return;
    }
    const row = snap.swap[focus];
    const real = row[focus];
    if (swapSel && swapSel[0] !== swapSel[1]) {
      const v = row[swapSel[1]];
      detail.textContent = `${teams[focus].team} with ${teams[swapSel[1]].team}'s schedule: ${asRecord(v)} instead of ${asRecord(real)}.`;
      return;
    }
    const others = row.map((v, j) => ({ v, j })).filter((x) => x.j !== focus);
    const best = others.reduce((a, b) => (b.v > a.v ? b : a));
    const worst = others.reduce((a, b) => (b.v < a.v ? b : a));
    detail.textContent =
      `${teams[focus].team} is really ${asRecord(real)}. Best case ${asRecord(best.v)} with ${teams[best.j].team}'s schedule; ` +
      `worst case ${asRecord(worst.v)} with ${teams[worst.j].team}'s.`;
  }

  function render() {
    renderSticky();
    renderOdds();
    renderWhatIf();
    renderLuck();
    renderSwap();
  }

  dark.addEventListener("change", renderSwap);
  render();
  $("main").hidden = false;
}

main().catch((e) => {
  $("asof").textContent = "Couldn't load the season. Try again in a minute.";
  console.error(e);
});
