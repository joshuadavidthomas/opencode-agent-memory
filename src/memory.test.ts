import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createMemoryStore } from "./memory";

async function mkTmpDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join("/tmp/", "opencode-memory-"));
  return root;
}

describe("store", () => {
  test("seeds and writes blocks", async () => {
    const dir = await mkTmpDir();
    const store = createMemoryStore(dir);
    await store.ensureSeed();

    const blocks = await store.listBlocks("all");
    const labels = blocks.map((b) => `${b.scope}:${b.label}`);

    expect(labels).toContain("global:persona");
    expect(labels).toContain("global:human");
    expect(labels).toContain("project:project");

    await store.setBlock("project", "project", "hello");
    const b = await store.getBlock("project", "project");
    expect(b.value).toBe("hello");
  });

  test("soft limit: setBlock past limit succeeds and reports overage", async () => {
    const dir = await mkTmpDir();
    const store = createMemoryStore(dir);
    await store.ensureSeed();

    const res = await store.setBlock("project", "project", "x".repeat(20), { limit: 10 });
    expect(res.chars).toBe(20);
    expect(res.limit).toBe(10);
    expect(res.overage).toBe(10);

    const b = await store.getBlock("project", "project");
    expect(b.value).toBe("x".repeat(20));
  });

  test("soft limit: replace can grow a block past its limit", async () => {
    const dir = await mkTmpDir();
    const store = createMemoryStore(dir);
    await store.ensureSeed();

    await store.setBlock("project", "project", "abc", { limit: 3 });
    const res = await store.replaceInBlock("project", "project", "c", "cdef");
    expect(res.chars).toBe(6);
    expect(res.overage).toBe(3);

    const b = await store.getBlock("project", "project");
    expect(b.value).toBe("abcdef");
  });

  test("batch replace applies multiple edits in order", async () => {
    const dir = await mkTmpDir();
    const store = createMemoryStore(dir);
    await store.ensureSeed();

    await store.setBlock("project", "project", "alpha\nbeta\ngamma");
    const res = await store.replaceManyInBlock("project", "project", [
      { oldText: "beta", newText: "BETA" },
      { oldText: "gamma", newText: "GAMMA" },
    ]);

    expect(res.chars).toBe("alpha\nBETA\nGAMMA".length);
    const b = await store.getBlock("project", "project");
    expect(b.value).toBe("alpha\nBETA\nGAMMA");
  });

  test("not-found error includes the current value", async () => {
    const dir = await mkTmpDir();
    const store = createMemoryStore(dir);
    await store.ensureSeed();

    await store.setBlock("project", "project", "current content");
    await expect(
      store.replaceInBlock("project", "project", "missing", "new"),
    ).rejects.toThrow(/Current value of project:project[\s\S]*current content/);
  });
});
