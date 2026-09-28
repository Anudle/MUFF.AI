# WhatsApp sender (MUFF-62)

The Tuesday digest is written for the league's WhatsApp group. Until MUFF-62
it landed on Telegram and someone forwarded it by hand. This doc records how
it now posts itself, and why it's built as a separate process rather than a
line in the digest Lambda.

## Why the unofficial protocol

WhatsApp has no bot API for consumer groups. The official Cloud API only lets
a verified business number message people individually, or post into
invite-only groups the API itself created — it cannot attach to the league's
existing chat (MUFF-12 rejected it for exactly this). The only thing that can
post into an existing group is a *member* of that group.

So the sender is a **linked device** on a **spare number** that has been added
to the group, speaking the WhatsApp Web protocol via
[Baileys](https://github.com/WhiskeySockets/Baileys). Trade-offs, stated
plainly:

- **It is against WhatsApp's terms of service.** The realistic consequence is
  the spare number being logged out or banned. Never link the admin's own
  number. One post and one poll a week into one 14-person group is as
  low-volume as automation gets, but the risk is not zero.
- **It needs a session.** A linked device holds encryption keys on disk
  (`WA_AUTH_DIR`) and a live WebSocket. Lose the dir and you re-pair; the
  session also gets invalidated occasionally on WhatsApp's side (a 401), and
  recovery is one code entry on the spare phone.

## Why a separate process, fed by an outbox

The digest runs on a stateless Lambda fired by EventBridge Scheduler. Its
filesystem evaporates between runs and it lives for seconds. A Baileys session
needs the opposite: persisted creds and a socket that stays open (or at least
opens, syncs, and stays up long enough to send). Putting Baileys inside the
Lambda would mean an S3-backed auth-state adapter, a cold WebSocket handshake
every Tuesday, and a pairing flow nobody is awake for at 7am. That's the
fragile shape and the one most likely to trip WhatsApp's automation heuristics.

Instead the two processes share the thing they already share — the store:

```
digest Lambda (Tue 7:00 MT, stateless)         whatsapp sender (long-lived, anywhere)
  runDigest --send                                every 60 s:
   ├─ Telegram: sendMessage   (unchanged)          store.list("outbox") → pending
   ├─ Telegram: sendPoll      (unchanged)          sock.sendMessage(WA_GROUP_JID, {text})
   └─ store.write("outbox/<season>-wNN.json")      sock.sendMessage(WA_GROUP_JID, {poll})
        {status:"pending", text, poll}             store.write(same key, status:"sent"|"failed")
        non-fatal (Telegram already has it)        on failure → Telegram DM to the admin
```

`src/digest/outbox.ts` owns the record; `src/whatsapp/` owns the session and
the drain. Nothing under `src/digest/` imports Baileys, so the Lambda bundle
is unchanged. Why not SQS: one message a week does not need a queue service,
and the store is already the cross-process seam for fixtures, history and the
run archive. Why the digest doesn't call the sender directly: they are not in
the same process, and must not be — a WhatsApp outage can never block the
Telegram recap.

The outbox record is keyed by week (one per week, re-sending a week
overwrites it) and carries `status`, `sent_at`, `error`, plus `poll_status` /
`poll_error` for the Game of the Week poll. The sender never throws out of
its loop: a failed text marks the record `failed` and DMs the admin; a failed
poll is recorded and logged but never retried or allowed to block the text —
the same shrug rule the Telegram poll follows in `src/digest/run.ts`.

## The poll: post-only

The sender posts a native WhatsApp poll (same question and options as the
Telegram one). It does **not** read the votes back. WhatsApp poll votes are
end-to-end encrypted `messages.update` events; decrypting them requires the
original poll message to be stored (its `messageSecret` is the key) and a
session listening all week. That forces daemon-only hosting and adds a store
of sent messages — deferred. Receipts in next week's digest still come from
the Telegram poll (MUFF-40).

## Running it

```
npm run whatsapp            # daemon: connect, drain the outbox every 60 s
npm run whatsapp:once       # connect, drain once, exit — the manual Tuesday fallback
npm run whatsapp:groups     # connect, print every group's JID + name, exit
```

Env (in `.env` locally, secrets on the host):

| Var | What |
|---|---|
| `WA_AUTH_DIR` | Session creds. Default `.wa-auth`. **Must persist across restarts/deploys.** Gitignored. |
| `WA_PHONE_NUMBER` | The spare number, digits only with country code (`13035550100`). Enables pairing by code. |
| `WA_GROUP_JID` | The league group, `…@g.us`. Find it with `npm run whatsapp:groups`. |
| `TELEGRAM_ADMIN_CHAT_ID` | The admin's *private* chat with the bot (`npm run telegram:chats`). Pairing codes and failure alerts go here. Never the league chat. |
| `TELEGRAM_BOT_TOKEN` | Already set for the digest. Only loaded when an alert is actually sent. |
| `HISTORY_BUCKET` | Same bucket as the digest, so the sender sees the Lambda's outbox. Unset → local `data/outbox/`. |

### Pairing (first run, and after a 401)

1. Start the sender with no `WA_AUTH_DIR` present.
2. With `WA_PHONE_NUMBER` set, an 8-character pairing code arrives in the
   admin's Telegram chat. On the spare phone: WhatsApp → Linked devices →
   Link a device → *Link with phone number instead* → enter the code. Codes
   expire in about a minute; restart the sender for a fresh one.
   Without a phone number the raw QR string is printed to the terminal
   instead (paste it into any QR renderer and scan it) — local-dev only.
3. Expect one `515 restart required` close right after pairing; the sender
   reconnects on its own. "WhatsApp connected" means you're linked.
4. Restarts reconnect silently from `WA_AUTH_DIR`. If WhatsApp logs the
   device out (401), the sender wipes the dir, alerts the admin, and starts
   a fresh pairing — one code entry to recover.

### Finding the group

`npm run whatsapp:groups` prints `id  subject` for every group the spare
number is in. Add the spare number to the league group first. Set
`WA_GROUP_JID` to the league's id. Test against a throwaway group before
pointing it at the real one.

### Failure modes and what you'll see

| What happened | Telegram digest | WhatsApp | Admin DM |
|---|---|---|---|
| Sender down on Tuesday | delivered | posts whenever the sender is next up (outbox is durable) | none until a send fails |
| Session logged out (401) | delivered | nothing until re-paired | "logged out — re-pairing" + a new code |
| Send throws (bad JID, network) | delivered | record `failed`, no retry | what failed, and which record to flip back to `pending` |
| Outbox write fails in the Lambda | delivered | never queued | none — `MUFF_RUN.whatsapp_queued: false` in CloudWatch is the signal |

Each drained record logs one `MUFF_WA` JSON line (`week, run_id, status,
poll_status, error`) — the sender's equivalent of the digest's `MUFF_RUN`.

## Hosting

The code is host-agnostic. Whatever runs it needs: a persistent `WA_AUTH_DIR`;
read/write on the history bucket's `outbox/` prefix; outbound HTTPS/WSS; and
the env above. Options, cheapest first: a Mac under `launchd` (fine for
`whatsapp:once` on Tuesday mornings, not for a daemon on a laptop that
sleeps); a Fly machine with a volume; a t4g.nano. Defining that host is IaC
and is hands-on work for the October plan — it is not part of MUFF-62.

Do not commit `.wa-auth/`, phone numbers, or JIDs.
