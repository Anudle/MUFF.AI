/**
 * MUFF-71 — write the league site's snapshot to the store. The static page
 * (web/) fetches this one blob; the Tuesday digest run refreshes it, which is
 * what keeps a link shared once in the group from going stale.
 *
 * Non-fatal by the same rule as the run archive and the WhatsApp outbox: the
 * digest is the product, the site is a side output, and a provider hiccup or
 * a missing IAM grant here must never cost the league its Tuesday message.
 */

import { store } from "../store.ts";
import { deriveSeason } from "./derive.ts";
import { gatherSeasonInputs } from "./season.ts";

export const SITE_KEY = "site/season.json";

/** Returns the key written, or null if anything failed (never throws). */
export async function publishSite(): Promise<string | null> {
  try {
    const snapshot = deriveSeason(await gatherSeasonInputs());
    await store.write(SITE_KEY, snapshot);
    return SITE_KEY;
  } catch (e) {
    console.error(`League site snapshot failed (${SITE_KEY}): ${(e as Error).message}`);
    return null;
  }
}
