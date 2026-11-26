/**
 * MUFF-72 — one scout run: fetch the pool, derive the board, remember what
 * was already sent, write the local page, and (only when asked) DM the owner.
 *
 * Privacy rule: the only places this writes are the store key `scout/…`, the
 * local file `data/scout/board.html`, and TELEGRAM_ADMIN_CHAT_ID. Never
 * `site/`, never the league chat.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getFreeAgents } from "../mcp/data.ts";
import { store } from "../store.ts";
import { DEFAULT_OPTIONS, deriveScout, newAlerts } from "./derive.ts";
import { renderAlert, renderBoardHtml } from "./render.ts";
import type { Candidate, Scout, ScoutInputs, ScoutOptions, ScoutSnapshot } from "./types.ts";

export const scoutKey = (season: string, week: number) =>
  `scout/${season}-w${String(week).padStart(2, "0")}.json`;

/** Local only, by design: see the privacy rule above. */
export const BOARD_PATH = path.join(process.cwd(), "data", "scout", "board.html");

/** Fetch. The provider's return shape is the derive's input shape. */
export async function gatherScoutInputs(week?: number): Promise<ScoutInputs> {
  return getFreeAgents(week);
}

export interface ScoutResult {
  scout: Scout;
  /** Alert-worthy pickups not sent before this run. */
  fresh: Candidate[];
  /** The Telegram text for `fresh`, or null when there is nothing new. */
  text: string | null;
  delivered: boolean;
  board_path: string;
}

export async function runScout(
  opts: { week?: number; send?: boolean; options?: ScoutOptions } = {},
): Promise<ScoutResult> {
  const scout = deriveScout(await gatherScoutInputs(opts.week), opts.options ?? DEFAULT_OPTIONS);
  const asOf = new Date().toISOString();

  const key = scoutKey(scout.season, scout.week);
  const previous = await store.read<ScoutSnapshot>(key);
  const alreadySent = previous?.alerted ?? [];
  const fresh = newAlerts(scout.alerts, alreadySent);
  const text = fresh.length > 0 ? renderAlert(scout, fresh) : null;

  let delivered = false;
  if (opts.send && text) {
    const chatId = Number(process.env.TELEGRAM_ADMIN_CHAT_ID);
    if (!chatId) {
      throw new Error(
        "TELEGRAM_ADMIN_CHAT_ID is not set: the scout only ever messages the admin's private chat. " +
          "Find it with `npm run telegram:chats`.",
      );
    }
    // Dynamic import: bot.ts throws at load without TELEGRAM_BOT_TOKEN, and a
    // print-only run should not need it. sendMessage throws on failure, so a
    // pickup is only remembered as sent once Telegram accepted it.
    const { sendMessage } = await import("../telegram/bot.ts");
    await sendMessage(chatId, text);
    delivered = true;
  }

  const snapshot: ScoutSnapshot = {
    as_of: asOf,
    alerted: delivered ? [...alreadySent, ...fresh.map((c) => c.player_key)] : alreadySent,
    scout,
  };
  await store.write(key, snapshot);

  fs.mkdirSync(path.dirname(BOARD_PATH), { recursive: true });
  fs.writeFileSync(BOARD_PATH, renderBoardHtml(scout, asOf));

  return { scout, fresh, text, delivered, board_path: BOARD_PATH };
}
