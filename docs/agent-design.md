# MUFF.ai interactive agent — design decisions (MUFF-13)

Agent: `src/agent/agent.ts` · Prompt: `src/agent/prompt.ts` · REPL: `npm run agent`
Built on the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) consuming the
MUFF-15 MCP server as its entire tool layer.

## Why the Agent SDK (and not the plain Anthropic SDK)

Two different products, easy to confuse:

| | Anthropic SDK (`@anthropic-ai/sdk`) | **Agent SDK** (`@anthropic-ai/claude-agent-sdk`) |
|---|---|---|
| What it is | HTTP client for the Messages API | Claude Code's harness as a library |
| Agent loop | You write it (or use its tool runner) | Built in — `query()` runs the whole loop |
| MCP support | Server-side connector (beta) | First-class: spawns stdio servers, namespaces tools |
| Context mgmt | You manage / opt into compaction | Automatic compaction |

MUFF-13's requirement is "no hand-rolled routing": the model decides which of the
five Yahoo tools to call, in what order, with what arguments. The Agent SDK gives
us that loop, MCP wiring, session resume, and cost accounting for free — the whole
agent is ~80 lines.

## Tool layer = the MCP server, nothing else

- `mcpServers` launches `src/mcp/server.ts` over stdio; tools surface to the model
  as `mcp__muff-fantasy__get_roster` etc.
- `allowedTools: ["mcp__muff-fantasy__*"]` + every built-in (Bash, Read, Write,
  Web*) in `disallowedTools`. With the surface reduced to five read-only tools,
  `permissionMode: "bypassPermissions"` is safe — there is nothing destructive to
  permit. If MUFF ever gets write tools (set lineup, add/drop), this decision must
  be revisited with a human-in-the-loop permission gate.
- Routing quality comes from the MUFF-15 tool descriptions ("my game" vs
  "everyone's games" vs "season-cumulative"), not from any code here. That's the
  point of the exercise: invest in descriptions, delete the router.

## System prompt (`src/agent/prompt.ts`)

Custom string — **not** the `claude_code` preset, which is tuned for coding agents
and would waste tokens describing tools we disabled. Sections:

1. **Persona + league context** — who MUFF is, which league it serves.
2. **Grounding rules** — every stat must come from a tool result this turn;
   prevents the classic failure of the model "remembering" plausible scores.
3. **Error contract** — mirrors the server's `{status:"error",code,message}`
   envelope: follow the message's instruction, never surface raw JSON.
4. **Voice + format** — Telegram-shaped: short, plain text, data-backed trash talk.

## Model tiering (documented decision)

| Request type | Model | Why |
|---|---|---|
| Single-tool lookups ("did I win?", "show standings") | Haiku | One tool call + one short sentence; Haiku is ~5x cheaper and routing five well-described tools is well within its ability |
| Composition ("recap the week", "who should talk trash?") | Sonnet (default) | Multi-tool sequencing + synthesis + tone; where quality is visible |

`pickModel()` is a deliberately crude regex-and-length heuristic, and that's a
considered choice, not a shortcut:

- It's a **cost lever, not a router** — whichever model runs still makes every
  tool decision itself. A wrong guess costs pennies or a slightly fancy answer to
  a simple question; it never breaks correctness.
- The alternative — a Haiku *classifier call* before every request — adds latency
  and cost to 100% of requests to optimize the cheap half of them. Wrong trade at
  this traffic level.
- **When ambiguous, default up** (Sonnet): over-serving a simple question wastes
  cents; under-serving a composition question produces a visibly worse answer.
- Revisit with real per-request cost data once MUFF-16 tracing lands.

## Context management

- **Trim at the tool boundary** (MUFF-15): Yahoo's ~40 fields/player never enter
  the context window; tools return only what an answer needs. This is the highest-
  leverage context decision in the system and it lives server-side on purpose —
  every consumer (interactive agent, digest) benefits.
- **`maxTurns: 8`** bounds a runaway loop; five read-only tools rarely need >3.
- **SDK auto-compaction** handles long REPL/chat sessions.
- Persistent league facts (manager names, rivalries) in a scratchpad/DynamoDB:
  deferred until the digest (MUFF-38) proves what's worth persisting.

## Structured output

The Agent SDK returns free text (it's a chat harness — no `output_config` JSON
schema forcing at this layer). For the interactive agent that's correct: answers
are chat messages. The digest (MUFF-38) is the data-shaped consumer; it will get
format enforcement via prompt-level format contract + a parse step, or by calling
the Messages API directly with `output_config.format` for the stats block.

## Error handling

Two layers, both "errors as data":

1. **Tool errors** never throw — the server returns the envelope, the model reads
   `message` and adapts (retry later, drop the week arg, tell the user to re-auth).
2. **Loop errors** (`error_max_turns`, execution failure) are caught in `askMuff`
   and become a friendly fallback line; details go to stderr for the operator.

## Auth note

The SDK resolves credentials in order: `ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN`
→ the local Claude Code login. Local dev rides the existing login; the Lambda
deployment (MUFF-39) will need an API key in Secrets Manager.

## CCA-F mapping

- **Agentic architecture (27%)** — harness-vs-model split, tool-driven routing,
  locked-down tool surface, permission modes.
- **Context management & reliability (15%)** — trim-at-boundary, maxTurns,
  compaction, errors-as-data.
- **Prompt engineering & structured output (20%)** — system prompt sections,
  grounding rules, format constraints, where schema-forcing does (and doesn't) fit.
