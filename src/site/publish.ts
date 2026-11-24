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
import type { SeasonSnapshot, SiteDigest } from "./types.ts";

export const SITE_KEY = "site/season.json";

/**
 * The digest already on the site, so a snapshot rebuilt without one (a dry
 * run, `npm run site:snapshot`) keeps the week's recap instead of erasing it.
 * It reads the snapshot's own key rather than the run archive: the digest
 * role can get `site/*` but cannot list `runs/`.
 */
export async function carriedDigest(season: string): Promise<SiteDigest | undefined> {
  try {
    const current = await store.read<SeasonSnapshot>(SITE_KEY);
    return current?.season === season ? current.digest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the key written, or null if anything failed (never throws).
 * Pass `digest` only for a run that is delivering: what the site shows is
 * what the chat saw.
 */
export async function publishSite(digest?: SiteDigest): Promise<string | null> {
  try {
    const snapshot = deriveSeason(await gatherSeasonInputs());
    const shown = digest ?? (await carriedDigest(snapshot.season));
    if (shown) snapshot.digest = shown;
    await store.write(SITE_KEY, snapshot);
    return SITE_KEY;
  } catch (e) {
    console.error(`League site snapshot failed (${SITE_KEY}): ${(e as Error).message}`);
    return null;
  }
}
