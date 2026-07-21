/**
 * MUFF-39 — pluggable token persistence.
 *
 * The MCP server runs in two homes with different storage realities:
 *  - Local dev: a gitignored JSON file (.tokens.json), same as MUFF-11.
 *  - Lambda: the filesystem is ephemeral (and /var/task is read-only), so
 *    tokens live in AWS Secrets Manager instead. Refreshed tokens are
 *    written BACK to the secret so the next cold container doesn't have to
 *    re-refresh with a stale expires_at.
 *
 * Selection is by environment: if TOKENS_SECRET_ID is set (the deploy
 * script sets it on the Lambda), use Secrets Manager; otherwise the file.
 * Callers only ever see the TokenStore interface — this is the seam
 * client.ts promised in MUFF-11.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { TokenSet } from "./oauth.ts";

export interface TokenStore {
  load(): Promise<TokenSet>;
  save(tokens: TokenSet): Promise<void>;
}

// NOTE: no constructor parameter properties here — node's strip-only TS
// mode erases types but can't transform syntax that generates code.
class FileTokenStore implements TokenStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<TokenSet> {
    if (!existsSync(this.path)) {
      throw new Error(
        `No ${this.path} found — run \`npm run auth\` first to complete the OAuth flow.`,
      );
    }
    return JSON.parse(readFileSync(this.path, "utf8")) as TokenSet;
  }

  async save(tokens: TokenSet): Promise<void> {
    writeFileSync(this.path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }
}

/**
 * The AWS SDK is imported lazily so the stdio/local path never loads it.
 * In the Lambda bundle esbuild inlines it; locally it's a devDependency.
 */
class SecretsManagerTokenStore implements TokenStore {
  private client?: import("@aws-sdk/client-secrets-manager").SecretsManagerClient;
  private readonly secretId: string;

  constructor(secretId: string) {
    this.secretId = secretId;
  }

  private async sdk() {
    const mod = await import("@aws-sdk/client-secrets-manager");
    this.client ??= new mod.SecretsManagerClient({});
    return { mod, client: this.client };
  }

  async load(): Promise<TokenSet> {
    const { mod, client } = await this.sdk();
    const res = await client.send(
      new mod.GetSecretValueCommand({ SecretId: this.secretId }),
    );
    if (!res.SecretString) {
      throw new Error(
        `Secret ${this.secretId} has no token payload — run \`npm run auth\` locally, then \`npm run deploy\` to seed it.`,
      );
    }
    return JSON.parse(res.SecretString) as TokenSet;
  }

  async save(tokens: TokenSet): Promise<void> {
    const { mod, client } = await this.sdk();
    await client.send(
      new mod.PutSecretValueCommand({
        SecretId: this.secretId,
        SecretString: JSON.stringify(tokens),
      }),
    );
  }
}

const secretId = process.env.TOKENS_SECRET_ID;

export const tokenStore: TokenStore = secretId
  ? new SecretsManagerTokenStore(secretId)
  : new FileTokenStore(process.env.TOKENS_PATH ?? ".tokens.json");
