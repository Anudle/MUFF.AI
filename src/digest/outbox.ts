/**
 * MUFF-62 — the WhatsApp outbox: the seam between the digest Lambda and the
 * WhatsApp sender.
 *
 * The digest runs on a stateless Lambda; posting to WhatsApp needs a
 * long-lived linked-device session (src/whatsapp/). They never share a
 * process, so they share the store instead: a delivering run writes ONE
 * record per week here, and the sender — wherever it runs — picks it up,
 * posts it, and flips the status. The store already is the seam every other
 * cross-process handoff in this repo uses (fixtures, history, run archive),
 * so no queue service is needed for one message a week.
 *
 * Writing the outbox is deliberately NOT fatal, same rule as the Telegram
 * poll: by the time this runs the digest is already in the Telegram chat.
 */

import { store } from "../store.ts";

export const OUTBOX_PREFIX = "outbox";

export interface OutboxRecord {
  season: string;
  week: number;
  run_id: string;
  /** The rendered digest, verbatim — `*bold*` is native WhatsApp markup. */
  text: string;
  created_at: string;
  /** Game of the Week, same question and options as the Telegram poll (MUFF-40). */
  poll?: { question: string; options: string[] };
  status: "pending" | "sent" | "failed";
  sent_at?: string;
  error?: string;
  /** Post-only: WhatsApp votes are E2E-encrypted and are not counted (see docs/whatsapp-sender.md). */
  poll_status?: "sent" | "failed";
  poll_error?: string;
}

/** `outbox/2026-w07.json` — one record per week; re-sending a week overwrites it. */
export function outboxKey(season: string, week: number): string {
  return `${OUTBOX_PREFIX}/${season}-w${String(week).padStart(2, "0")}.json`;
}

/** Returns the key written, or null if the write failed (never throws). */
export async function enqueueWhatsApp(
  record: Omit<OutboxRecord, "status" | "created_at">,
): Promise<string | null> {
  const key = outboxKey(record.season, record.week);
  try {
    await store.write(key, { ...record, created_at: new Date().toISOString(), status: "pending" } satisfies OutboxRecord);
    return key;
  } catch (e) {
    console.error(`WhatsApp outbox write failed for ${key}: ${(e as Error).message}`);
    return null;
  }
}

export async function listOutbox(): Promise<string[]> {
  return store.list(OUTBOX_PREFIX);
}

export async function loadOutbox(key: string): Promise<OutboxRecord | null> {
  return store.read<OutboxRecord>(key);
}

export async function saveOutbox(key: string, record: OutboxRecord): Promise<void> {
  await store.write(key, record);
}
