import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const MODEL_DTYPE = "q8";

let pipelinePromise: Promise<any> | undefined;

async function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return pipeline("feature-extraction", MODEL_NAME, {
        dtype: MODEL_DTYPE,
      });
    })();
  }
  return pipelinePromise;
}

function getCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg || path.join(os.homedir(), ".cache");
  return path.join(base, "opencode-agent-memory", "embeddings");
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export type EmbeddingData = {
  text: string;
  embedding: number[];
};

export async function generateEmbedding(text: string): Promise<number[]> {
  const cacheDir = getCacheDir();
  const hash = hashText(text);
  const cachePath = path.join(cacheDir, `${hash}.json`);

  try {
    const cached = await fs.readFile(cachePath, "utf-8");
    const data: EmbeddingData = JSON.parse(cached);
    return data.embedding;
  } catch {
    // Cache miss, generate new embedding
  }

  const pipe = await getPipeline();
  const output = await pipe(text, { pooling: "mean", normalize: true });
  const embedding = Array.from(output.data as Float32Array) as number[];

  await fs.mkdir(cacheDir, { recursive: true });
  const data: EmbeddingData = { text, embedding };
  await fs.writeFile(cachePath, JSON.stringify(data), "utf-8");

  return embedding;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Embedding dimension mismatch: ${a.length} vs ${b.length}`,
    );
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dotProduct += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}
