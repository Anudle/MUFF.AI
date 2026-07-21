/**
 * MUFF-38/43 — persisted digest state across weekly runs.
 *
 * Power-ranking arrows need what was PUBLISHED last week — regenerating
 * week N-1 on the fly could rank differently and the arrows would lie.
 * So each run persists its rankings; the next run reads them.
 *
 * Storage seam (same pattern as the MUFF-39 token store): local JSON file
 * in dev; S3 on Lambda, selected by HISTORY_BUCKET, because a Lambda
 * container's filesystem evaporates between invocations. The whole history
 * is one small JSON object, so read-modify-write of a single S3 key is
 * plenty — the digest runs once a week, there is no concurrency to fight.
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface History {
  power_rankings: Record<string, { rank: number; team: string }[]>; // "season:week"
}

const EMPTY: History = { power_rankings: {} };

interface HistoryStore {
  load(): Promise<History>;
  save(history: History): Promise<void>;
}

class FileHistoryStore implements HistoryStore {
  private readonly file = path.join(process.cwd(), "data", "digest-history.json");

  async load(): Promise<History> {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return EMPTY;
    }
  }

  async save(history: History): Promise<void> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(history, null, 1) + "\n");
  }
}

/** AWS SDK imported lazily so local runs never load it (it's bundled on Lambda). */
class S3HistoryStore implements HistoryStore {
  private client?: import("@aws-sdk/client-s3").S3Client;
  private readonly bucket: string;
  private readonly key: string;

  constructor(bucket: string, key: string) {
    this.bucket = bucket;
    this.key = key;
  }

  private async sdk() {
    const mod = await import("@aws-sdk/client-s3");
    this.client ??= new mod.S3Client({});
    return { mod, client: this.client };
  }

  async load(): Promise<History> {
    const { mod, client } = await this.sdk();
    try {
      const res = await client.send(
        new mod.GetObjectCommand({ Bucket: this.bucket, Key: this.key }),
      );
      return JSON.parse((await res.Body!.transformToString()) ?? "");
    } catch (e) {
      // First run in a fresh bucket: no object yet. Anything else is real.
      if ((e as { name?: string }).name === "NoSuchKey") return EMPTY;
      throw e;
    }
  }

  async save(history: History): Promise<void> {
    const { mod, client } = await this.sdk();
    await client.send(
      new mod.PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
        Body: JSON.stringify(history, null, 1) + "\n",
        ContentType: "application/json",
      }),
    );
  }
}

const bucket = process.env.HISTORY_BUCKET;

const store: HistoryStore = bucket
  ? new S3HistoryStore(bucket, process.env.HISTORY_KEY ?? "digest-history.json")
  : new FileHistoryStore();

export async function loadPowerRankings(
  season: string,
  week: number,
): Promise<{ rank: number; team: string }[] | null> {
  return (await store.load()).power_rankings[`${season}:${week}`] ?? null;
}

export async function savePowerRankings(
  season: string,
  week: number,
  rankings: { rank: number; team: string }[],
): Promise<void> {
  const history = await store.load();
  history.power_rankings[`${season}:${week}`] = rankings.map(({ rank, team }) => ({ rank, team }));
  await store.save(history);
}
