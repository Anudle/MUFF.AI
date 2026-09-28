/**
 * MUFF-62 — one linked-device WhatsApp session, kept alive.
 *
 * WhatsApp has no bot API for consumer groups (MUFF-12), so the sender is a
 * "linked device" on a SPARE number, speaking the WhatsApp Web protocol via
 * Baileys. That is against WhatsApp's terms: the realistic failure is the
 * spare number being logged out or banned, never the admin's own account —
 * which is why the number must be a spare (docs/whatsapp-sender.md).
 *
 * Lifecycle, in the order it matters:
 *   - creds live in WA_AUTH_DIR (persist it — a lost dir means re-pairing)
 *   - no creds → pairing: a pairing code (WA_PHONE_NUMBER set) DM'd to the
 *     admin via Telegram, or the raw QR string in the terminal for local dev
 *   - close with 401 (logged out) → wipe creds, alert, pair again
 *   - any other close → reconnect with capped backoff, creds untouched
 */

import { existsSync, rmSync } from "node:fs";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { ILogger } from "@whiskeysockets/baileys/lib/Utils/logger.js";
import { notifyAdmin } from "./alert.ts";

const AUTH_DIR = process.env.WA_AUTH_DIR ?? ".wa-auth";
const PHONE = process.env.WA_PHONE_NUMBER?.replace(/\D/g, "");

const progress = console.error;

/** Baileys logs a lot; we log the events we care about ourselves. */
const quiet: ILogger = {
  level: "silent",
  child: () => quiet,
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error(obj, msg) {
    progress(`[baileys] ${msg ?? ""}`, obj instanceof Error ? obj.message : "");
  },
};

let sock: WASocket | null = null;
let connected = false;
let closing = false;
let pairingRequested = false;
let reconnects = 0;
const waiters: (() => void)[] = [];

export function isConnected(): boolean {
  return connected;
}

/** Resolves once the socket is open, or rejects after `ms`. */
export function waitUntilConnected(ms: number): Promise<void> {
  if (connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WhatsApp not connected after ${ms / 1000}s`)), ms);
    waiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function connect(): Promise<void> {
  closing = false;
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const s = makeWASocket({
    auth: state,
    logger: quiet,
    browser: Browsers.macOS("Chrome"),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });
  sock = s;
  s.ev.on("creds.update", saveCreds);
  s.ev.on("connection.update", (u) => {
    if (u.qr && !state.creds.registered) void pair(s, u.qr);
    if (u.connection === "connecting") progress("WhatsApp connecting…");
    if (u.connection === "open") {
      connected = true;
      reconnects = 0;
      progress("WhatsApp connected");
      waiters.splice(0).forEach((w) => w());
    }
    if (u.connection === "close") {
      connected = false;
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (closing) return;
      if (code === DisconnectReason.loggedOut) {
        progress("WhatsApp logged this device out (401) — wiping session and re-pairing.");
        if (existsSync(AUTH_DIR)) rmSync(AUTH_DIR, { recursive: true, force: true });
        pairingRequested = false;
        void notifyAdmin("⚠️ WhatsApp logged the MUFF sender out. Re-pairing — a new code/QR follows.");
        void connect();
        return;
      }
      // 515 restart-required (normal right after pairing), 408 timed out,
      // 428/440 closed/replaced, network blips: keep creds, come back.
      const delay = Math.min(60_000, 2_000 * 2 ** reconnects++);
      progress(`WhatsApp connection closed (${code ?? "no code"}) — reconnecting in ${delay / 1000}s.`);
      setTimeout(() => void connect(), delay);
    }
  });
}

/** First run / after 401: hand the admin a way to link the spare number. */
async function pair(s: WASocket, qr: string): Promise<void> {
  if (pairingRequested) return;
  pairingRequested = true;
  if (PHONE) {
    try {
      const code = await s.requestPairingCode(PHONE);
      const pretty = code.match(/.{1,4}/g)?.join("-") ?? code;
      await notifyAdmin(
        `📲 MUFF WhatsApp sender needs pairing.\n\nOn the spare phone: WhatsApp → Linked devices → Link a device → *Link with phone number instead*, then enter:\n\n*${pretty}*\n\n(Expires in about a minute — restart the sender for a new one.)`,
      );
      progress(`Pairing code for +${PHONE}: ${pretty}`);
    } catch (e) {
      progress(`Pairing code request failed (${(e as Error).message}); falling back to the QR string below.`);
      progress(`QR: ${qr}`);
    }
    return;
  }
  progress("No WA_PHONE_NUMBER set — scan this QR string (paste into any QR renderer) with the spare phone:");
  progress(qr);
  await notifyAdmin("📲 MUFF WhatsApp sender needs pairing and no WA_PHONE_NUMBER is set — check the sender's terminal for the QR.");
}

function live(): WASocket {
  if (!sock || !connected) throw new Error("WhatsApp is not connected");
  return sock;
}

export async function sendGroupText(jid: string, text: string): Promise<void> {
  await live().sendMessage(jid, { text });
}

/** A native WhatsApp poll, single choice. Votes are not read back (post-only, see the doc). */
export async function sendGroupPoll(jid: string, question: string, options: string[]): Promise<void> {
  await live().sendMessage(jid, { poll: { name: question, values: options, selectableCount: 1 } });
}

/** `id  subject` for every group the spare number is in — the operator picks WA_GROUP_JID. */
export async function listGroups(): Promise<{ id: string; subject: string }[]> {
  const groups = await live().groupFetchAllParticipating();
  return Object.values(groups).map((g) => ({ id: g.id, subject: g.subject }));
}

export function disconnect(): void {
  closing = true;
  connected = false;
  sock?.end(undefined);
  sock = null;
}
