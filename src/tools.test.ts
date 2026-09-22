import { afterEach, describe, expect, test } from "bun:test";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createMemoryStore } from "./memory";
import { MemoryGet, MemoryOversized, MemoryReplace } from "./tools";

const context = {} as ToolContext;
const directories: string[] = [];

async function setup() {
  const directory = await fs.mkdtemp(path.join("/tmp/", "memory-tools-"));
  directories.push(directory);
  const store = createMemoryStore(directory, { disableGlobal: true });
  await store.ensureSeed();
  return store;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

describe("memory tools", () => {
  test("memory_get returns fresh content and modification metadata", async () => {
    const store = await setup();
    await store.setBlock("project", "project", "fresh value");

    const result = await MemoryGet(store, { disableGlobal: true }).execute(
      { label: "project" },
      context,
    );
    expect(result.content).toContain("fresh value");
    expect(result.content).toContain("last_modified=");
  });

  test("memory_replace applies batch edits", async () => {
    const store = await setup();
    await store.setBlock("project", "project", "alpha\nbeta");

    await MemoryReplace(store, { disableGlobal: true }).execute({
      label: "project",
      edits: [
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "beta", newText: "BETA" },
      ],
    }, context);
    expect((await store.getBlock("project", "project")).value).toBe("ALPHA\nBETA");
  });

  test("memory_oversized reports worst blocks without exposing values", async () => {
    const store = await setup();
    const secret = `SECRET-${"x".repeat(95)}`;
    await store.setBlock("project", "project", secret, { limit: 100 });
    await store.setBlock("project", "small", "small", { limit: 100 });

    const result = await MemoryOversized(store, { disableGlobal: true }).execute(
      { scope: "project", threshold: 90 },
      context,
    );
    expect(result.content).toContain("project:project");
    expect(result.content).not.toContain("project:small");
    expect(result.content).not.toContain(secret);
  });

  test("tool label schemas match store validation", async () => {
    const store = await setup();
    const schema = MemoryReplace(store).input as {
      properties: { label: { pattern: string; minLength: number; maxLength: number } };
    };
    expect(schema.properties.label).toEqual(expect.objectContaining({
      pattern: "^[a-zA-Z0-9][a-zA-Z0-9-_]{1,60}$",
      minLength: 2,
      maxLength: 61,
    }));
  });
});
