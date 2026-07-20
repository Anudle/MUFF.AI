/**
 * MUFF-13 — interactive REPL for the MUFF agent (npm run agent).
 *
 * Multi-turn: the session id from each answer is fed back into the next
 * question, so follow-ups ("what about week 3?") keep their context.
 * Operator telemetry (model, turns, cost) goes to stderr, answers to stdout.
 *
 * One-shot mode: npm run agent -- "did I win this week?"
 */

import * as readline from "node:readline/promises";
import { askMuff, pickModel } from "../src/agent/agent.ts";

async function ask(question: string, sessionId?: string) {
  const started = Date.now();
  const answer = await askMuff(question, { sessionId });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${answer.text}\n`);
  console.error(
    `  [${answer.model} · ${answer.numTurns} turns · $${answer.costUsd.toFixed(4)} · ${secs}s]`,
  );
  return answer.sessionId;
}

const oneShot = process.argv.slice(2).join(" ").trim();
if (oneShot) {
  await ask(oneShot);
  process.exit(0);
}

console.error("MUFF agent — ask about your league (Ctrl+C or 'exit' to quit)");
const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
let sessionId: string | undefined;

while (true) {
  const q = (await rl.question("muff> ")).trim();
  if (!q) continue;
  if (q === "exit" || q === "quit") break;
  if (q.startsWith("/model ")) {
    console.error(`pickModel would choose: ${pickModel(q.slice(7))}`);
    continue;
  }
  try {
    sessionId = await ask(q, sessionId);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
  }
}
rl.close();
