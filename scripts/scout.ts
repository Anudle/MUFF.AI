/**
 * MUFF-72 — the free-agent scout from the CLI.
 *
 *   npm run scout                    → current week, print the board (nothing sent)
 *   npm run scout -- --week 11       → what today's free agents scored in week 11
 *   npm run scout -- --send          → DM new pickups to TELEGRAM_ADMIN_CHAT_ID
 *   npm run scout -- --min-gain 3    → lower the bar (default 5)
 *   npm run scout -- --open          → open the local board page afterwards
 *
 * The body lives in src/scout/run.ts so a scheduled Lambda can share it.
 */

import { execFile } from "node:child_process";
import { DEFAULT_OPTIONS } from "../src/scout/derive.ts";
import { renderBoardText } from "../src/scout/render.ts";
import { runScout } from "../src/scout/run.ts";

const args = process.argv.slice(2);
const value = (flag: string) => {
  const i = args.indexOf(flag);
  return i !== -1 ? Number(args[i + 1]) : undefined;
};

const week = value("--week");
const minGain = value("--min-gain");
if ([week, minGain].some((v) => v !== undefined && !Number.isFinite(v))) {
  console.error("--week and --min-gain take a number.");
  process.exit(1);
}

const result = await runScout({
  week,
  send: args.includes("--send"),
  options: { ...DEFAULT_OPTIONS, minGain: minGain ?? DEFAULT_OPTIONS.minGain },
});

console.log(renderBoardText(result.scout));
console.log("");
if (result.text) {
  console.log(result.text.replace(/\\([_*`\[])/g, "$1").replace(/\*/g, ""));
  console.error(result.delivered ? "\nSent to the admin chat." : "\nNot sent (pass --send to deliver).");
} else {
  const total = result.scout.alerts.length;
  console.error(
    total > 0
      ? `Nothing new: all ${total} pickup(s) were already sent this week.`
      : "No free agent cleared the alert bar.",
  );
}
console.error(`Board: ${result.board_path}`);

if (args.includes("--open")) execFile("open", [result.board_path]);
