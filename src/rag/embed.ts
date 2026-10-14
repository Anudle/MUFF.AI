/**
 * MUFF-63 — text → vector, via Amazon Titan Text Embeddings v2 on Bedrock.
 *
 * Why Titan and not Voyage: the index lives in the MUFF S3 bucket, the
 * Lambdas already run under IAM roles in this account, and the Dev user can
 * already invoke the model — one more `bedrock:InvokeModel` statement versus
 * a new vendor account, a new secret in Secrets Manager, and a new key to
 * rotate. Quality is a non-issue at this corpus size (~100 short chunks of
 * one league's prose); operational surface is the whole decision.
 *
 * 256 dimensions, not the default 1024: the corpus is tiny and the queries
 * are short, so the extra dimensions buy nothing and quadruple the index.
 * `normalize: true` makes every vector unit-length, so cosine similarity in
 * `index.ts` is a plain dot product.
 *
 * The SDK is imported lazily, like the S3 client in store.ts: local runs that
 * never embed (the unit tests, the MCP server answering a non-RAG tool) must
 * not pay for loading it.
 */

export const EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";
export const EMBEDDING_DIMENSIONS = 256;

let client: import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient | undefined;

async function sdk() {
  const mod = await import("@aws-sdk/client-bedrock-runtime");
  client ??= new mod.BedrockRuntimeClient({ region: process.env.BEDROCK_REGION ?? "us-east-1" });
  return { mod, client };
}

export async function embedText(text: string): Promise<number[]> {
  const { mod, client } = await sdk();
  const res = await client.send(
    new mod.InvokeModelCommand({
      modelId: EMBEDDING_MODEL,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({ inputText: text, dimensions: EMBEDDING_DIMENSIONS, normalize: true }),
    }),
  );
  const parsed = JSON.parse(new TextDecoder().decode(res.body)) as { embedding: number[] };
  return parsed.embedding;
}

/** Titan has no batch endpoint; a small concurrency cap keeps ~100 calls under a few seconds without tripping throttling. */
export async function embedTexts(texts: string[], concurrency = 4): Promise<number[][]> {
  const out: number[][] = new Array(texts.length);
  let next = 0;
  async function worker() {
    while (next < texts.length) {
      const i = next++;
      out[i] = await embedText(texts[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
  return out;
}
