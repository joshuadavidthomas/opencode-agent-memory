import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { atomicWriteFile, buildFrontmatterDocument, splitFrontmatter } from "./frontmatter";

let directory: string;
let file: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-frontmatter-"));
  file = path.join(directory, "block.md");
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("frontmatter", () => {
  test("round-trips a document", () => {
    const doc = buildFrontmatterDocument({ label: "notes", limit: 10 }, "body");
    const { frontmatterText, body } = splitFrontmatter(doc);

    expect(frontmatterText).toContain("label: notes");
    expect(body.trim()).toBe("body");
  });

  test("treats text without frontmatter as the body", () => {
    const { frontmatterText, body } = splitFrontmatter("just text");

    expect(frontmatterText).toBeUndefined();
    expect(body).toBe("just text");
  });
});

describe("atomicWriteFile", () => {
  test("writes content that can be read back", async () => {
    await atomicWriteFile(file, "hello");

    expect(await fs.readFile(file, "utf-8")).toBe("hello");
  });

  test("leaves no temp files behind", async () => {
    await atomicWriteFile(file, "hello");

    expect(await fs.readdir(directory)).toEqual(["block.md"]);
  });

  // Regression: a fixed temp path made concurrent writers collide. The first
  // rename consumes the shared temp file and the others fail with ENOENT, so a
  // concurrent memory_set/memory_replace silently loses its update.
  test("concurrent writers to one path all resolve", async () => {
    const payloads = Array.from({ length: 8 }, (_, index) =>
      String.fromCharCode(65 + index).repeat(8192),
    );

    const results = await Promise.allSettled(
      payloads.map((payload) => atomicWriteFile(file, payload)),
    );

    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected.map((result) => String((result as PromiseRejectedResult).reason))).toEqual(
      [],
    );

    // The file holds exactly one writer's content - never a mix of two.
    const written = await fs.readFile(file, "utf-8");
    expect(new Set(written).size).toBe(1);
    expect(payloads).toContain(written);
  });

  test("removes the temp file when the write fails", async () => {
    // A directory cannot be written as a file, so the write step throws.
    const missing = path.join(directory, "missing", "block.md");

    await expect(atomicWriteFile(missing, "hello")).rejects.toThrow();

    expect(await fs.readdir(directory)).toEqual([]);
  });
});
