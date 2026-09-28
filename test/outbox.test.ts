/**
 * MUFF-62 — the outbox write is the one seam between the digest Lambda and
 * the WhatsApp sender, so pin its two promises: the record shape/key the
 * sender reads, and "never throws" (a broken outbox must not cost the league
 * the Telegram digest that already went out).
 *
 * The store roots itself at process.cwd()/data when it is first imported, so
 * the test chdirs into a scratch dir BEFORE importing outbox.ts. Nothing here
 * touches the repo's data/ or S3.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "muff-outbox-"));
const originalCwd = process.cwd();
let outbox: typeof import("../src/digest/outbox.ts");

before(async () => {
  delete process.env.HISTORY_BUCKET; // force the local FileStore
  process.chdir(scratch);
  outbox = await import("../src/digest/outbox.ts");
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("enqueueWhatsApp writes one pending record per week at outbox/<season>-wNN.json", async () => {
  const key = await outbox.enqueueWhatsApp({
    season: "2026",
    week: 3,
    run_id: "run-123",
    text: "*Week 3* recap",
    poll: { question: "🎯 Game of the Week 4: who wins?", options: ["Alpha", "Bravo"] },
  });

  assert.equal(key, "outbox/2026-w03.json"); // zero-padded so sort() orders weeks
  const written = JSON.parse(fs.readFileSync(path.join(scratch, "data", key!), "utf8"));
  assert.equal(written.status, "pending");
  assert.equal(written.text, "*Week 3* recap");
  assert.equal(written.run_id, "run-123");
  assert.deepEqual(written.poll, { question: "🎯 Game of the Week 4: who wins?", options: ["Alpha", "Bravo"] });
  assert.ok(!Number.isNaN(Date.parse(written.created_at)), "created_at is an ISO timestamp");
  assert.equal(written.sent_at, undefined, "the sender, not the digest, sets sent_at");
});

test("enqueueWhatsApp returns null instead of throwing when the store write fails", async () => {
  // A regular file where the outbox directory should be makes mkdir/write fail.
  fs.rmSync(path.join(scratch, "data", "outbox"), { recursive: true, force: true });
  fs.writeFileSync(path.join(scratch, "data", "outbox"), "not a directory");

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    const key = await outbox.enqueueWhatsApp({ season: "2026", week: 4, run_id: "run-456", text: "x" });
    assert.equal(key, null);
    assert.match(errors.join("\n"), /outbox write failed for outbox\/2026-w04\.json/);
  } finally {
    console.error = originalError;
  }
});
