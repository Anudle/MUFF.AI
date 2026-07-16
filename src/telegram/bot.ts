/**
 * ANU-12 — Telegram bot: long polling + command routing.
 *
 * Long polling (getUpdates) needs zero infrastructure — perfect for dev
 * and honestly fine for a 12-person league in production too. The webhook
 * variant for Lambda can come later if we want push-based delivery;
 * handleUpdate() is already the seam for it.
 *
 * Zero runtime dependencies: raw fetch against the Bot API.
 */

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN — get one from @BotFather.");
const API = `https://api.telegram.org/bot${TOKEN}`;

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string; title?: string };
    from?: { first_name?: string; username?: string };
    text?: string;
  };
}

export async function sendMessage(chatId: number, text: string): Promise<void> {
  const res = await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  if (!res.ok) console.error("sendMessage failed:", res.status, await res.text());
}

/** Route one update. This is the seam the LangGraph agent (ANU-13) plugs into. */
export async function handleUpdate(update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const name = msg.from?.first_name ?? "coach";
  const command = msg.text.split(/[\s@]/)[0].toLowerCase();

  switch (command) {
    case "/start":
      await sendMessage(
        chatId,
        `🏈 *MUFF.ai reporting for duty, ${name}.*\n\n` +
          `I know your league better than you do. Try:\n` +
          `/roster — your current lineup\n` +
          `/matchup — this week's opponent\n` +
          `/standings — league standings\n\n` +
          `_Agent brain arrives in ANU-13. For now I'm just plumbing with personality._`,
      );
      break;
    case "/roster":
    case "/matchup":
    case "/standings":
      await sendMessage(
        chatId,
        `\`${command}\` is wired but the Yahoo-powered brain lands in ANU-13/14. ` +
          `Soon I'll be judging your bench decisions with *receipts*.`,
      );
      break;
    default:
      if (command.startsWith("/")) {
        await sendMessage(chatId, `Unknown command \`${command}\`. Try /start.`);
      }
    // Non-command group chatter: ignored for now. The agent decides later
    // when to jump in (mention-triggered, ANU-13).
  }
}

/** Long-poll loop. Ctrl-C to stop. */
async function poll(): Promise<never> {
  console.log("MUFF.ai polling for updates… (Ctrl-C to stop)");
  let offset = 0;
  while (true) {
    try {
      const res = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`);
      const body = (await res.json()) as { ok: boolean; result: TgUpdate[] };
      for (const update of body.result ?? []) {
        offset = update.update_id + 1;
        await handleUpdate(update).catch((e) => console.error("handleUpdate:", e));
      }
    } catch (e) {
      console.error("poll error (retrying in 3s):", e);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// Run the loop when executed directly (npm run bot).
if (import.meta.url === `file://${process.argv[1]}`) {
  poll();
}
