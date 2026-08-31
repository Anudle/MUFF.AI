/**
 * The JSON blob store behind everything MUFF persists.
 *
 * Extracted from history.ts when run archiving (MUFF-16) needed the same
 * local-file-vs-S3 seam that power rankings (MUFF-38/43) already had;
 * promoted out of src/digest/ when the Sleeper players cache (MUFF-49)
 * became its first non-digest consumer. One store, keyed by path:
 * `digest-history.json`, `runs/2025-w16-….json`, `players/sleeper-nfl.json`.
 *
 * Local dev writes under `data/`; Lambda writes to HISTORY_BUCKET (named for
 * its first tenant, now the one MUFF blob bucket), because a Lambda
 * container's filesystem evaporates between invocations. Everything here is
 * modest JSON written at most daily — no concurrency to fight, no
 * pagination to worry about.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface JsonStore {
  read<T>(key: string): Promise<T | null>;
  write(key: string, value: unknown): Promise<void>;
  /** Keys under `prefix`, sorted. Used to walk the run archive. */
  list(prefix: string): Promise<string[]>;
}

class FileStore implements JsonStore {
  private readonly root = path.join(process.cwd(), "data");

  private file(key: string) {
    return path.join(this.root, key);
  }

  async read<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(fs.readFileSync(this.file(key), "utf8")) as T;
    } catch {
      return null;
    }
  }

  async write(key: string, value: unknown): Promise<void> {
    const file = this.file(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 1) + "\n");
  }

  async list(prefix: string): Promise<string[]> {
    const dir = path.join(this.root, prefix);
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.posix.join(prefix, f))
        .sort();
    } catch {
      return [];
    }
  }
}

/** AWS SDK imported lazily so local runs never load it (it's bundled on Lambda). */
class S3Store implements JsonStore {
  private client?: import("@aws-sdk/client-s3").S3Client;
  private readonly bucket: string;

  // Explicit assignment, not a parameter property: `node
  // --experimental-strip-types` (how everything runs in dev) rejects those.
  constructor(bucket: string) {
    this.bucket = bucket;
  }

  private async sdk() {
    const mod = await import("@aws-sdk/client-s3");
    this.client ??= new mod.S3Client({});
    return { mod, client: this.client };
  }

  async read<T>(key: string): Promise<T | null> {
    const { mod, client } = await this.sdk();
    try {
      const res = await client.send(
        new mod.GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return JSON.parse((await res.Body!.transformToString()) ?? "") as T;
    } catch (e) {
      // First run in a fresh bucket: no object yet. Anything else is real.
      if ((e as { name?: string }).name === "NoSuchKey") return null;
      throw e;
    }
  }

  async write(key: string, value: unknown): Promise<void> {
    const { mod, client } = await this.sdk();
    await client.send(
      new mod.PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(value, null, 1) + "\n",
        ContentType: "application/json",
      }),
    );
  }

  async list(prefix: string): Promise<string[]> {
    const { mod, client } = await this.sdk();
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await client.send(
        new mod.ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix.endsWith("/") ? prefix : `${prefix}/`,
          ContinuationToken: token,
        }),
      );
      for (const o of res.Contents ?? []) if (o.Key?.endsWith(".json")) keys.push(o.Key);
      token = res.NextContinuationToken;
    } while (token);
    return keys.sort();
  }
}

const bucket = process.env.HISTORY_BUCKET;

export const store: JsonStore = bucket ? new S3Store(bucket) : new FileStore();

/** Where the store is pointed, for logging/CLI output. */
export const storeLabel = bucket ? `s3://${bucket}/` : "data/";
