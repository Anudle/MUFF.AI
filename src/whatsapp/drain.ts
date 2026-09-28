/**
 * MUFF-62 — drain the outbox: post every pending week to the league group.
 *
 * Text first, then the poll. A failed text marks the record `failed` and
 * alerts the admin; a failed poll is recorded and logged but never blocks or
 * retries the text — the same shrug rule the Telegram poll follows in
 * src/digest/run.ts. Nothing here throws out of the loop: the daemon calls
 * this on a timer and one bad record must not stop the next week's.
 */

import { listOutbox, loadOutbox, saveOutbox, type OutboxRecord } from "../digest/outbox.ts";
import { notifyAdmin } from "./alert.ts";
import { sendGroupPoll, sendGroupText, waitUntilConnected } from "./session.ts";

const progress = console.error;

/** One JSON line per drained record, mirroring the digest's MUFF_RUN convention. */
function logLine(record: OutboxRecord, key: string): void {
  console.log(
    JSON.stringify({
      tag: "MUFF_WA",
      key,
      run_id: record.run_id,
      season: record.season,
      week: record.week,
      status: record.status,
      poll_status: record.poll_status ?? null,
      error: record.error ?? record.poll_error ?? null,
    }),
  );
}

/** Returns how many records were posted this pass. */
export async function drainOutbox(): Promise<number> {
  const jid = process.env.WA_GROUP_JID;
  if (!jid) throw new Error("Set WA_GROUP_JID — run `npm run whatsapp:groups` to find it.");

  let keys: string[];
  try {
    keys = await listOutbox();
  } catch (e) {
    progress(`Outbox list failed: ${(e as Error).message}`);
    return 0;
  }

  let posted = 0;
  for (const key of keys) {
    const record = await loadOutbox(key).catch((e) => {
      progress(`Outbox read failed for ${key}: ${(e as Error).message}`);
      return null;
    });
    if (!record || record.status !== "pending") continue;

    try {
      await waitUntilConnected(60_000);
      await sendGroupText(jid, record.text);
      record.status = "sent";
      record.sent_at = new Date().toISOString();
      posted++;
      progress(`Posted week ${record.week} digest to WhatsApp.`);
    } catch (e) {
      record.status = "failed";
      record.error = (e as Error).message;
      progress(`WhatsApp send failed for ${key}: ${record.error}`);
      await notifyAdmin(
        `❌ WhatsApp digest for week ${record.week} did NOT post: ${record.error}\n\nTelegram already has it. Fix the sender and set the outbox record back to "pending" to retry (${key}).`,
      );
    }

    if (record.status === "sent" && record.poll) {
      try {
        await sendGroupPoll(jid, record.poll.question, record.poll.options);
        record.poll_status = "sent";
        progress(`Posted Game of the Week poll: ${record.poll.options.join(" vs ")}.`);
      } catch (e) {
        record.poll_status = "failed";
        record.poll_error = (e as Error).message;
        progress(`WhatsApp poll failed (digest already posted): ${record.poll_error}`);
      }
    }

    try {
      await saveOutbox(key, record);
    } catch (e) {
      // The post happened; a lost status write means a duplicate next pass,
      // which is loud enough for the admin to notice and fix by hand.
      progress(`Outbox status write failed for ${key}: ${(e as Error).message}`);
      await notifyAdmin(`⚠️ WhatsApp posted week ${record.week} but could not mark it sent (${key}) — it may repost. Mark it by hand.`);
    }
    logLine(record, key);
  }
  return posted;
}
