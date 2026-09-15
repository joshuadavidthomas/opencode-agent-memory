import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createMemoryStore } from "./memory";
import { MemoryOversized } from "./tools";

// IMPORTANT: only use the "project" scope in tests. The "global" scope always
// resolves to ~/.config/opencode/memory/ and would overwrite real memory.
async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join("/tmp/", "opencode-memory-"));
}

const ctx = {} as never;

describe("memory_oversized", () => {
  test("lists blocks at/above threshold, worst first, metadata only", async () => {
    const dir = await mkTmpDir();
    const store = createMemoryStore(dir);
    await store.ensureSeed();

    const secret = "SECRET_VALUE_" + "x".repeat(20);
    await store.setBlock("project", "project", secret + "y".repeat(930), { limit: 1000 });
    await store.setBlock("project", "alpha", "z".repeat(920), { limit: 1000 });
    await store.setBlock("project", "beta", "small", { limit: 1000 });

    const out = await MemoryOversized(store).execute({ threshold: 90, scope: "project" }, ctx);

    expect(out).toContain("project:project");
    expect(out).toContain("project:alpha");
    expect(out).not.toContain("project:beta");
    expect(out).not.toContain(secret);
    expect(out.indexOf("project:project")).toBeLessThan(out.indexOf("project:alpha"));
    expect(out).toContain("of 3");
  });

  test("reports over-limit blocks with over>0", async () => {
    const dir = await mkTmpDir();
    const store = createMemoryStore(dir);
    await store.ensureSeed();

    await store.setBlock("project", "project", "x".repeat(1100), { limit: 1000 });

    const out = await MemoryOversized(store).execute({ scope: "project" }, ctx);

    expect(out).toContain("110.0%");
    expect(out).toContain("over=100");
    expect(out).toContain("1 over limit");
  });

  test("name filter is a case-insensitive substring", async () => {
    const dir = await mkTmpDir();
    const store = createMemoryStore(dir);
    await store.ensureSeed();

    await store.setBlock("project", "project", "x".repeat(950), { limit: 1000 });
    await store.setBlock("project", "alpha", "y".repeat(950), { limit: 1000 });

    const out = await MemoryOversized(store).execute({ name: "ALP", scope: "project" }, ctx);

    expect(out).toContain("project:alpha");
    expect(out).not.toContain("project:project");
  });

  test("reports when nothing matches", async () => {
    const dir = await mkTmpDir();
    const store = createMemoryStore(dir);
    await store.ensureSeed();

    const out = await MemoryOversized(store).execute({ threshold: 90, scope: "project" }, ctx);
    expect(out).toContain("No memory blocks at or above 90%");
  });
});
