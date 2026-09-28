/**
 * MUFF-62 — the WhatsApp sender process.
 *
 *   npm run whatsapp            → connect, then drain the outbox every 60 s, forever
 *   npm run whatsapp:once       → connect, drain once, exit (manual Tuesday fallback,
 *                                 or a cron on any box that has the auth dir)
 *   npm run whatsapp:groups     → connect, print every group's JID + name, exit
 *
 * Deliberately a separate process from the digest Lambda: Baileys needs a
 * long-lived socket and a persisted auth dir, neither of which a stateless
 * Lambda has. Where this runs (Fly machine, tiny EC2, a Mac under launchd)
 * is an infra decision — the code only needs WA_AUTH_DIR to persist, the
 * store (HISTORY_BUCKET or local data/) reachable, and outbound HTTPS/WSS.
 */

import { storeLabel } from "../store.ts";
import { drainOutbox } from "./drain.ts";
import { connect, disconnect, listGroups, waitUntilConnected } from "./session.ts";

const DRAIN_EVERY_MS = 60_000;
const CONNECT_TIMEOUT_MS = 90_000;

const args = process.argv.slice(2);
const once = args.includes("--once");
const groups = args.includes("--groups");
const progress = console.error;

process.on("SIGINT", () => {
  disconnect();
  process.exit(0);
});
process.on("SIGTERM", () => {
  disconnect();
  process.exit(0);
});

progress(`WhatsApp sender starting (outbox: ${storeLabel}outbox/, auth: ${process.env.WA_AUTH_DIR ?? ".wa-auth"})`);
await connect();
// First-run pairing takes longer than a reconnect: the human has to type a code.
await waitUntilConnected(process.env.WA_PHONE_NUMBER ? CONNECT_TIMEOUT_MS * 3 : CONNECT_TIMEOUT_MS);

if (groups) {
  for (const g of await listGroups()) console.log(`${g.id}  ${g.subject}`);
  progress("Set WA_GROUP_JID to the league group's id (ends in @g.us).");
  disconnect();
  process.exit(0);
}

if (once) {
  const n = await drainOutbox();
  progress(n ? `Posted ${n} record(s).` : "Nothing pending.");
  disconnect();
  process.exit(0);
}

const tick = async () => {
  try {
    await drainOutbox();
  } catch (e) {
    progress(`Drain failed: ${(e as Error).message}`);
  }
};
await tick();
setInterval(() => void tick(), DRAIN_EVERY_MS);
progress(`Watching the outbox every ${DRAIN_EVERY_MS / 1000}s. Ctrl-C to stop.`);
