/**
 * MUFF-62 — admin alerts for the WhatsApp sender go through the Telegram bot
 * that already exists. The sender's failure modes (logged out, send failed,
 * needs re-pairing) are exactly the ones that must reach a human, and the
 * bot is the one channel guaranteed to be up when WhatsApp isn't.
 *
 * `TELEGRAM_ADMIN_CHAT_ID` is the admin's private chat with the bot — never
 * the league chat. Without it, alerts degrade to a log line so the sender
 * still works in a bare local setup.
 */

const progress = console.error;

export async function notifyAdmin(text: string): Promise<void> {
  const chatId = Number(process.env.TELEGRAM_ADMIN_CHAT_ID);
  if (!chatId) {
    progress(`[admin alert — set TELEGRAM_ADMIN_CHAT_ID to receive this on Telegram]\n${text}`);
    return;
  }
  try {
    // Dynamic import: bot.ts throws at load without TELEGRAM_BOT_TOKEN, and
    // the sender should only need the token when it actually alerts.
    const { sendMessage } = await import("../telegram/bot.ts");
    await sendMessage(chatId, text);
  } catch (e) {
    progress(`Admin alert failed (${(e as Error).message}); the alert was:\n${text}`);
  }
}
