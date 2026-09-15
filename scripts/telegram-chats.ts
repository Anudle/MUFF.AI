/**
 * Print every chat the bot has seen recently, with its id — the way to find
 * TELEGRAM_CHAT_ID for the league group without posting anything in it.
 *
 *   npm run telegram:chats
 *
 * Adding the bot to a group produces a `my_chat_member` update on its own, so
 * nobody has to message the group. Two caveats:
 *  - getUpdates only returns updates the bot hasn't already consumed with an
 *    offset, and Telegram keeps them ~24h. If the group isn't listed, remove
 *    and re-add the bot, then run this again.
 *  - If `npm run bot` is polling at the same time it will eat the updates
 *    first; stop it before running this.
 */

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");

interface Chat {
  id: number;
  type: string;
  title?: string;
  first_name?: string;
  username?: string;
}
interface Update {
  message?: { chat: Chat };
  my_chat_member?: { chat: Chat; new_chat_member?: { status?: string } };
  channel_post?: { chat: Chat };
}

const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?allowed_updates=["message","my_chat_member","channel_post"]`);
const json = (await res.json()) as { ok: boolean; result?: Update[]; description?: string };
if (!json.ok) throw new Error(`getUpdates failed: ${json.description}`);

const seen = new Map<number, { chat: Chat; how: string }>();
for (const u of json.result ?? []) {
  const src = u.my_chat_member
    ? { chat: u.my_chat_member.chat, how: `added (${u.my_chat_member.new_chat_member?.status ?? "?"})` }
    : u.message
      ? { chat: u.message.chat, how: "message" }
      : u.channel_post
        ? { chat: u.channel_post.chat, how: "channel post" }
        : null;
  if (src) seen.set(src.chat.id, src);
}

if (seen.size === 0) {
  console.log("No updates pending. Add the bot to the group (or remove and re-add it), then re-run.");
} else {
  console.log(`\nChats the bot has seen (${seen.size}):\n`);
  for (const { chat, how } of seen.values()) {
    const label = chat.title ?? [chat.first_name, chat.username && `@${chat.username}`].filter(Boolean).join(" ");
    console.log(`  ${String(chat.id).padStart(16)}  ${chat.type.padEnd(10)}  ${label}  [${how}]`);
  }
  console.log("\nGroups have negative ids. Put the league group's id in .env as TELEGRAM_CHAT_ID, then redeploy.\n");
}
