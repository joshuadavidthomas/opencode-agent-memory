import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createMemoryStore } from "./memory";

async function mkTmpDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join("/tmp/", "opencode-memory-"));
  return root;
}

describe("store", () => {
  let home: string;
  let dir: string;
  let homedirSpy: { mockRestore(): void };

  beforeEach(async () => {
    home = await mkTmpDir();
    homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
    dir = path.join(home, "project");
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fs.rm(home, { recursive: true, force: true });
  });

  test("seeds and writes blocks", async () => {
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

  test("project-only seeding never creates global memory", async () => {
    const store = createMemoryStore(dir, { disableGlobal: true });
    await store.ensureSeed();

    expect((await store.listBlocks("all")).map((b) => `${b.scope}:${b.label}`))
      .toEqual(["project:project"]);
    await expect(fs.access(path.join(home, ".config", "opencode", "memory")))
      .rejects.toThrow();
    expect(await fs.readFile(path.join(dir, ".opencode", "memory", ".gitignore"), "utf-8"))
      .toBe("*\n");
  });

  test("disabled global access preserves files for re-enabling", async () => {
    const enabled = createMemoryStore(dir);
    await enabled.ensureSeed();
    await enabled.setBlock("global", "human", "Shared preferences");
    await enabled.setBlock("project", "human", "Project preferences");
    const globalBlocks = await enabled.listBlocks("global");
    const originals = await Promise.all(globalBlocks.map((b) => fs.readFile(b.filePath, "utf-8")));

    const disabled = createMemoryStore(dir, { disableGlobal: true });
    await disabled.ensureSeed();
    expect(await disabled.listBlocks("global")).toEqual([]);
    expect((await disabled.listBlocks("all")).map((b) => `${b.scope}:${b.label}`))
      .toEqual(["project:project", "project:human"]);
    await expect(disabled.getBlock("global", "human")).rejects.toThrow("Global memory scope is disabled");
    await expect(disabled.setBlock("global", "human", "wrong")).rejects.toThrow("Global memory scope is disabled");
    await expect(disabled.setBlock("global", "new-block", "wrong")).rejects.toThrow("Global memory scope is disabled");
    await expect(disabled.replaceInBlock("global", "human", "Shared", "wrong"))
      .rejects.toThrow("Global memory scope is disabled");
    await disabled.replaceInBlock("project", "human", "Project", "Updated");
    expect((await disabled.getBlock("project", "human")).value).toBe("Updated preferences");

    const restored = createMemoryStore(dir, { disableGlobal: false });
    await restored.ensureSeed();
    expect((await restored.listBlocks("global")).map((b) => b.label))
      .toEqual(["persona", "human"]);
    expect((await restored.getBlock("global", "human")).value).toBe("Shared preferences");
    expect(await Promise.all(globalBlocks.map((b) => fs.readFile(b.filePath, "utf-8"))))
      .toEqual(originals);
  });

  test("soft limits report overage without rejecting writes", async () => {
    const dir = await mkTmpDir();
    const store = createMemoryStore(dir, { disableGlobal: true });
    await store.ensureSeed();

    const set = await store.setBlock("project", "project", "abcdef", { limit: 3 });
    expect(set).toMatchObject({ chars: 6, limit: 3, overage: 3 });
    const replace = await store.replaceInBlock("project", "project", "f", "fghi");
    expect(replace).toMatchObject({ chars: 9, limit: 3, overage: 6 });
    expect((await store.getBlock("project", "project")).value).toBe("abcdefghi");
  });

  test("batch replace is atomic and reports the current value on mismatch", async () => {
    const dir = await mkTmpDir();
    const store = createMemoryStore(dir, { disableGlobal: true });
    await store.ensureSeed();
    await store.setBlock("project", "project", "alpha\nbeta\ngamma");

    await store.replaceManyInBlock("project", "project", [
      { oldText: "beta", newText: "BETA" },
      { oldText: "gamma", newText: "GAMMA" },
    ]);
    expect((await store.getBlock("project", "project")).value).toBe("alpha\nBETA\nGAMMA");

    await expect(store.replaceManyInBlock("project", "project", [
      { oldText: "alpha", newText: "ALPHA" },
      { oldText: "missing", newText: "value" },
    ])).rejects.toThrow(/Current value of project:project[\s\S]*ALPHA/);
    expect((await store.getBlock("project", "project")).value).toBe("alpha\nBETA\nGAMMA");
  });
});
