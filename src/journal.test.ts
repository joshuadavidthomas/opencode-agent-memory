import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createJournalStore, loadConfig } from "./journal";

// Mock the embeddings module to avoid downloading a real model in tests
mock.module("./embeddings", () => ({
  generateEmbedding: async (text: string) => {
    // Deterministic fake embedding based on text content
    const hash = Array.from(text).reduce(
      (acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0,
      0,
    );
    return Array.from({ length: 8 }, (_, i) => Math.sin(hash + i));
  },
  cosineSimilarity: (a: number[], b: number[]) => {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i]!;
      const bi = b[i]!;
      dot += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  },
}));

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join("/tmp/", "opencode-journal-"));
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  test("returns empty config when file does not exist", async () => {
    const dir = await mkTmpDir();
    const config = await loadConfig(dir);
    expect(config).toEqual({});
  });

  test("returns parsed config when file is valid", async () => {
    const dir = await mkTmpDir();
    await fs.writeFile(
      path.join(dir, "agent-memory.json"),
      JSON.stringify({ journal: { enabled: true } }),
    );
    const config = await loadConfig(dir);
    expect(config.journal?.enabled).toBe(true);
  });

  test("returns empty config when file has invalid JSON", async () => {
    const dir = await mkTmpDir();
    await fs.writeFile(path.join(dir, "agent-memory.json"), "not json{{{");
    const config = await loadConfig(dir);
    expect(config).toEqual({});
  });

  test("returns custom categories from config", async () => {
    const dir = await mkTmpDir();
    await fs.writeFile(
      path.join(dir, "agent-memory.json"),
      JSON.stringify({
        journal: { enabled: true, categories: ["bug", "feature", "note"] },
      }),
    );
    const config = await loadConfig(dir);
    expect(config.journal?.categories).toEqual(["bug", "feature", "note"]);
  });

  test("returns custom tags from config", async () => {
    const dir = await mkTmpDir();
    await fs.writeFile(
      path.join(dir, "agent-memory.json"),
      JSON.stringify({
        journal: {
          enabled: true,
          tags: [
            { name: "perf", description: "Performance optimization work" },
            { name: "debug", description: "Debugging sessions" },
          ],
        },
      }),
    );
    const config = await loadConfig(dir);
    expect(config.journal?.tags).toEqual([
      { name: "perf", description: "Performance optimization work" },
      { name: "debug", description: "Debugging sessions" },
    ]);
  });

  test("returns empty config when schema validation fails", async () => {
    const dir = await mkTmpDir();
    await fs.writeFile(
      path.join(dir, "agent-memory.json"),
      JSON.stringify({ journal: { enabled: "yes" } }),
    );
    const config = await loadConfig(dir);
    expect(config).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Journal Store
// ---------------------------------------------------------------------------

describe("journal store", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("write creates entry file with correct metadata", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const entry = await store.write({
      title: "Test insight",
      body: "Discovered an interesting pattern.",
      category: "insight",
      project: "/home/user/project",
      model: "claude-opus-4-6",
      provider: "anthropic",
      tags: ["testing"],
    });

    expect(entry.title).toBe("Test insight");
    expect(entry.category).toBe("insight");
    expect(entry.project).toBe("/home/user/project");
    expect(entry.model).toBe("claude-opus-4-6");
    expect(entry.provider).toBe("anthropic");
    expect(entry.tags).toEqual(["testing"]);
    expect(entry.body).toBe("Discovered an interesting pattern.");
    expect(entry.id).toMatch(/^\d{8}-\d{6}-\d{3}$/);

    // Verify file exists
    const raw = await fs.readFile(entry.filePath, "utf-8");
    expect(raw).toContain("title: Test insight");
    expect(raw).toContain("category: insight");
  });

  test("write defaults category to note", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const entry = await store.write({
      title: "A simple note",
      body: "Just a note.",
    });

    expect(entry.category).toBe("note");
  });

  test("write generates chronological filenames", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const e1 = await store.write({ title: "First", body: "First entry" });
    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 5));
    const e2 = await store.write({ title: "Second", body: "Second entry" });

    expect(e2.id > e1.id).toBe(true);
  });

  test("write saves embedding file alongside entry", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const entry = await store.write({
      title: "Embedding test",
      body: "This should get an embedding.",
    });

    const embeddingFile = entry.filePath.replace(/\.md$/, ".embedding");
    const raw = await fs.readFile(embeddingFile, "utf-8");
    const embedding = JSON.parse(raw);
    expect(Array.isArray(embedding)).toBe(true);
    expect(embedding.length).toBeGreaterThan(0);
  });

  test("read returns full entry by id", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const written = await store.write({
      title: "Read test",
      body: "Read me back.",
      category: "observation",
      tags: ["test", "read"],
    });

    const read = await store.read(written.id);
    expect(read.title).toBe("Read test");
    expect(read.body).toBe("Read me back.");
    expect(read.category).toBe("observation");
    expect(read.tags).toEqual(["test", "read"]);
  });

  test("read throws for nonexistent id", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    expect(store.read("99990101-000000-000")).rejects.toThrow(
      "Journal entry not found",
    );
  });

  test("read rejects path traversal", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    expect(store.read("../../../etc/passwd")).rejects.toThrow(
      "Invalid journal entry ID",
    );
  });

  test("search with no filters returns recent entries", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    await store.write({ title: "Entry 1", body: "First" });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({ title: "Entry 2", body: "Second" });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({ title: "Entry 3", body: "Third" });

    const result = await store.search({});
    expect(result.total).toBe(3);
    expect(result.entries.length).toBe(3);
    // Newest first (by recency score)
    expect(result.entries[0]!.title).toBe("Entry 3");
    expect(result.entries[2]!.title).toBe("Entry 1");
  });

  test("search filters by category", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    await store.write({ title: "An insight", body: "...", category: "insight" });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({ title: "A decision", body: "...", category: "decision" });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({ title: "Another insight", body: "...", category: "insight" });

    const result = await store.search({ category: "insight" });
    expect(result.total).toBe(2);
    expect(result.entries.every((e) => e.category === "insight")).toBe(true);
  });

  test("search filters by tags", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    await store.write({
      title: "Tagged",
      body: "...",
      tags: ["rust", "perf"],
    });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({
      title: "Other",
      body: "...",
      tags: ["python"],
    });

    const result = await store.search({ tags: ["rust"] });
    expect(result.total).toBe(1);
    expect(result.entries[0]!.title).toBe("Tagged");
  });

  test("search filters by project", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    await store.write({ title: "Project A", body: "...", project: "/proj/a" });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({ title: "Project B", body: "...", project: "/proj/b" });

    const result = await store.search({ project: "/proj/a" });
    expect(result.total).toBe(1);
    expect(result.entries[0]!.title).toBe("Project A");
  });

  test("search combines filters with AND logic", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    await store.write({
      title: "Match",
      body: "...",
      category: "insight",
      project: "/proj/a",
    });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({
      title: "Wrong category",
      body: "...",
      category: "decision",
      project: "/proj/a",
    });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({
      title: "Wrong project",
      body: "...",
      category: "insight",
      project: "/proj/b",
    });

    const result = await store.search({
      category: "insight",
      project: "/proj/a",
    });
    expect(result.total).toBe(1);
    expect(result.entries[0]!.title).toBe("Match");
  });

  test("search respects limit", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    for (let i = 0; i < 5; i++) {
      await store.write({ title: `Entry ${i}`, body: `Body ${i}` });
      await new Promise((r) => setTimeout(r, 5));
    }

    const result = await store.search({ limit: 2 });
    expect(result.entries.length).toBe(2);
    expect(result.total).toBe(5);
  });

  test("search handles empty journal directory", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const result = await store.search({});
    expect(result.entries.length).toBe(0);
    expect(result.total).toBe(0);
    expect(result.allTags).toEqual([]);
  });

  test("search returns allTags from all entries regardless of filters", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    await store.write({
      title: "Rust work",
      body: "...",
      category: "insight",
      tags: ["rust", "perf"],
    });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({
      title: "Python work",
      body: "...",
      category: "note",
      tags: ["python", "testing"],
    });

    // Filter to only insight category — allTags should still include all tags
    const result = await store.search({ category: "insight" });
    expect(result.total).toBe(1);
    expect(result.allTags).toEqual(["perf", "python", "rust", "testing"]);
  });

  test("search allTags deduplicates across entries", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    await store.write({ title: "A", body: "...", tags: ["rust", "perf"] });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({ title: "B", body: "...", tags: ["rust", "debugging"] });

    const result = await store.search({});
    expect(result.allTags).toEqual(["debugging", "perf", "rust"]);
  });

  test("search by text uses semantic matching", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    await store.write({
      title: "Rust performance",
      body: "Optimized the hot loop using SIMD instructions.",
    });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({
      title: "Python testing",
      body: "Set up pytest with coverage reporting.",
    });

    // With mock embeddings, text search falls through to semantic matching
    const result = await store.search({ text: "Rust performance" });
    // Should find at least the matching entry
    expect(result.total).toBeGreaterThan(0);
  });
});
