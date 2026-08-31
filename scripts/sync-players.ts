/**
 * MUFF-49 step 3 — manual players sync: `npm run sync:players`.
 *
 * Same code path as the daily sync Lambda. Local runs land in
 * data/players/; with HISTORY_BUCKET set (and AWS creds) it writes straight
 * to S3 — handy for seeding the cache before the first scheduled run.
 */

import { handler } from "../src/sleeper/sync-lambda.ts";

await handler();
