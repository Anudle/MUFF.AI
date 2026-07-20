/**
 * MUFF-13 — core interactive agent on the Claude Agent SDK.
 *
 * Architecture (CCA-F: agentic architecture):
 *  - query() runs the full agent loop (Claude Code harness as a library).
 *    It spawns the MUFF-15 MCP server as a stdio subprocess and hands the
 *    model its five tools. The MODEL routes to tools — there is no intent
 *    parsing or hand-rolled dispatch anywhere in this file.
 *  - Tool surface is locked down: only mcp__muff-fantasy__* is allowed and
 *    every built-in tool is disallowed, so bypassPermissions is safe — the
 *    agent can read fantasy data and do nothing else.
 *  - Context management: the MCP server already trims Yahoo payloads to the
 *    fields an answer needs (MUFF-15); maxTurns bounds runaway loops; the
 *    SDK compacts history automatically on long sessions.
 *  - Multi-turn: pass the sessionId from a previous answer to keep context.
 *
 * Model tiering: see pickModel() below and docs/agent-design.md.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { SYSTEM_PROMPT } from "./prompt.ts";

const MCP_SERVERS = {
  "muff-fantasy": {
    command: "node",
    args: ["--env-file=.env", "--experimental-strip-types", "src/mcp/server.ts"],
  },
};

// Everything the Claude Code harness ships that MUFF must never touch.
const BUILTIN_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit",
  "WebFetch", "WebSearch", "Task", "TodoWrite", "KillShell", "BashOutput",
];

export type MuffModel = "haiku" | "sonnet";

/**
 * Model tiering (documented decision — see docs/agent-design.md):
 * default to Sonnet; drop to Haiku only for questions that look like a
 * single-tool lookup with no composition (score/standings checks).
 * Deliberately crude — it's a cost lever, not a router: whichever model
 * runs still decides the tool calls itself. Revisit with real cost data
 * once MUFF-16 tracing lands.
 */
export function pickModel(question: string): MuffModel {
  const simple =
    /^(what('| i)?s|show|did i win|who am i playing|my (score|roster|matchup)|standings)\b/i;
  return simple.test(question.trim()) && question.length < 60 ? "haiku" : "sonnet";
}

export interface MuffAnswer {
  text: string;
  sessionId: string;
  model: MuffModel;
  costUsd: number;
  numTurns: number;
}

export interface AskOptions {
  /** Session to continue; omit to start fresh. */
  sessionId?: string;
  /** Force a model; omit to let pickModel() decide. */
  model?: MuffModel;
}

export async function askMuff(question: string, opts: AskOptions = {}): Promise<MuffAnswer> {
  const model = opts.model ?? pickModel(question);

  let text = "";
  let sessionId = opts.sessionId ?? "";
  let costUsd = 0;
  let numTurns = 0;

  for await (const message of query({
    prompt: question,
    options: {
      model,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: MCP_SERVERS,
      allowedTools: ["mcp__muff-fantasy__*"],
      disallowedTools: BUILTIN_TOOLS,
      permissionMode: "bypassPermissions",
      maxTurns: 8,
      ...(opts.sessionId ? { resume: opts.sessionId } : {}),
    },
  })) {
    if (message.type === "result") {
      sessionId = message.session_id;
      costUsd = message.total_cost_usd ?? 0;
      numTurns = message.num_turns ?? 0;
      if (message.subtype === "success") {
        text = message.result;
      } else {
        // error_max_turns / error_during_execution — give the chat a usable
        // reply instead of throwing; details are on stderr for the operator.
        console.error(`muff-agent: result subtype=${message.subtype}`);
        text = "I hit a snag pulling the league data — try that again in a minute.";
      }
    }
  }

  return { text, sessionId, model, costUsd, numTurns };
}
