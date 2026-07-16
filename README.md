# MUFF.ai 🏈

Monarch United Fantasy Football's agentic league companion. LangGraph agent over Yahoo Fantasy data (MCP tools), delivered via Telegram bot + an autonomous Tuesday digest forwarded to the league's WhatsApp group.

This scaffold covers **ANU-11** (Yahoo OAuth + token refresh) and **ANU-12** (Telegram bot, long polling + commands).

## Setup (~15 min, one time)

### 0. Install

```bash
npm install
cp .env.example .env
```

Requires Node 20+ (uses `--experimental-strip-types` to run TS directly — no build step in dev).

### 1. Yahoo app (5 min)

1. Go to https://developer.yahoo.com/apps/ → **Create an App**
2. Application type: **Installed Application** (this enables the `oob` redirect — no server needed)
3. API permissions: **Fantasy Sports → Read**
4. Copy the **Client ID** and **Client Secret** into `.env`

### 2. Telegram bot (3 min)

1. Message **@BotFather** on Telegram → `/newbot`
2. Name it (e.g. `MUFF.ai`), pick a username (e.g. `muffai_bot`)
3. Copy the token into `.env` as `TELEGRAM_BOT_TOKEN`

### 3. Authenticate with Yahoo

```bash
npm run auth    # opens consent URL, paste the code back
npm run smoke   # should print your league(s) — ANU-11 ✅
```

Tokens land in `.tokens.json` (gitignored, auto-refreshed on every API call). In the Lambda deployment this moves to Secrets Manager — `loadTokens`/`saveTokens` in `src/yahoo/client.ts` is the seam.

### 4. Run the bot

```bash
npm run bot     # long-polls Telegram; message your bot /start — ANU-12 ✅
```

## Layout

```
src/yahoo/oauth.ts     OAuth2 3-legged flow + refresh (ANU-11)
src/yahoo/client.ts    token persistence + authenticated fetch
src/telegram/bot.ts    long polling + command routing (ANU-12)
scripts/yahoo-auth.ts  one-time interactive OAuth handshake
scripts/smoke.ts       acceptance test: list your NFL leagues
```

## What's next (see Linear)

- **ANU-13** — LangGraph core agent: `handleUpdate()` in `bot.ts` is the seam
- **ANU-14** — roster & matchup intents over real Yahoo data
- **ANU-38** — the Tuesday digest: scheduled recap + data-grounded trash talk
- **ANU-15** — wrap Yahoo capabilities as an MCP server (CCA-F lab)
- **ANU-16** — evals + tracing

## Testing without a live season

Yahoo serves historical seasons — point queries at your 2025 league key to build and test the digest against real (embarrassing) league history before Week 1. Those become the golden dataset for ANU-16 evals.

