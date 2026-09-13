import { describe, expect, test, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { MemoryPlugin } from "./plugin";
import { renderMemoryBlocks } from "./prompt";

async function mkTmpDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join("/tmp/", "opencode-plugin-"));
  return root;
}

interface SystemMessage {
  content: string;
}

interface SystemTransformOutput {
  system: SystemMessage[];
}

describe("MemoryPlugin system message transformation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("should merge all system messages into one when multiple exist", async () => {
    const plugin = await MemoryPlugin({ directory: tmpDir });
    const transformHook = plugin["experimental.chat.system.transform"];

    const output: SystemTransformOutput = {
      system: [
        { content: "Provider system header" },
        { content: "Additional system instruction" },
      ],
    };

    // @ts-ignore - testing internal hook
    await transformHook({}, output);

    // Should merge all into exactly one system message
    expect(output.system.length).toBe(1);
    expect(output.system[0].content).toContain("<memory_blocks>");
    expect(output.system[0].content).toContain("Provider system header");
    expect(output.system[0].content).toContain("Additional system instruction");
  });

  test("should handle empty system array", async () => {
    const plugin = await MemoryPlugin({ directory: tmpDir });
    const transformHook = plugin["experimental.chat.system.transform"];

    const output: SystemTransformOutput = { system: [] };

    // @ts-ignore - testing internal hook
    await transformHook({}, output);

    // Should create one system message with just the memory blocks
    expect(output.system.length).toBe(1);
    expect(output.system[0].content).toContain("<memory_blocks>");
  });

  test("should handle single existing system message", async () => {
    const plugin = await MemoryPlugin({ directory: tmpDir });
    const transformHook = plugin["experimental.chat.system.transform"];

    const output: SystemTransformOutput = {
      system: [{ content: "Existing system content" }],
    };

    // @ts-ignore - testing internal hook
    await transformHook({}, output);

    // Should still have exactly one system message
    expect(output.system.length).toBe(1);
    expect(output.system[0].content).toContain("<memory_blocks>");
    expect(output.system[0].content).toContain("Existing system content");
  });

  test("should prepend memory blocks before provider system content", async () => {
    const plugin = await MemoryPlugin({ directory: tmpDir });
    const transformHook = plugin["experimental.chat.system.transform"];

    const output: SystemTransformOutput = {
      system: [{ content: "Provider system header" }],
    };

    // @ts-ignore - testing internal hook
    await transformHook({}, output);

    // Memory blocks should come first
    const content = output.system[0].content;
    const memoryIndex = content.indexOf("<memory_blocks>");
    const headerIndex = content.indexOf("Provider system header");

    expect(memoryIndex).toBeLessThan(headerIndex);
  });

  test("should handle string-typed system messages", async () => {
    // Some providers may use string instead of { content: string }
    const plugin = await MemoryPlugin({ directory: tmpDir });
    const transformHook = plugin["experimental.chat.system.transform"];

    const output: SystemTransformOutput = {
      system: [
        { content: "String content" },
        { content: "More content" },
      ],
    };

    // @ts-ignore - testing internal hook
    await transformHook({}, output);

    expect(output.system.length).toBe(1);
    expect(output.system[0].content).toContain("String content");
    expect(output.system[0].content).toContain("More content");
  });
});

describe("renderMemoryBlocks output structure", () => {
  test("renders valid memory blocks xml", () => {
    const xml = renderMemoryBlocks([
      {
        scope: "global",
        label: "persona",
        description: "Your persona",
        limit: 5000,
        readOnly: false,
        value: "I am an AI assistant",
        filePath: "/tmp/persona.md",
        lastModified: new Date("2025-01-15T08:00:00Z"),
      },
    ]);

    expect(xml).toContain("<memory_blocks>");
    expect(xml).toContain("<persona>");
    expect(xml).toContain("</persona>");
    expect(xml).toContain("<memory_instructions>");
    expect(xml).toContain("<memory_metadata>");
  });

  test("includes line numbers in memory block values", () => {
    const xml = renderMemoryBlocks([
      {
        scope: "global",
        label: "notes",
        description: "Notes",
        limit: 1000,
        readOnly: false,
        value: "line one\nline two\nline three",
        filePath: "/tmp/notes.md",
        lastModified: new Date("2025-01-15T08:00:00Z"),
      },
    ]);

    expect(xml).toContain("1→ line one");
    expect(xml).toContain("2→ line two");
    expect(xml).toContain("3→ line three");
  });

  test("handles empty memory block values", () => {
    const xml = renderMemoryBlocks([
      {
        scope: "project",
        label: "empty",
        description: "Empty block",
        limit: 1000,
        readOnly: false,
        value: "",
        filePath: "/tmp/empty.md",
        lastModified: new Date("2025-01-15T08:00:00Z"),
      },
    ]);

    expect(xml).toContain("<empty>");
    expect(xml).toContain("<value>\n\n</value>");
  });

  test("marks read-only blocks correctly", () => {
    const xml = renderMemoryBlocks([
      {
        scope: "project",
        label: "readonly",
        description: "Read only",
        limit: 1000,
        readOnly: true,
        value: "content",
        filePath: "/tmp/readonly.md",
        lastModified: new Date("2025-01-15T08:00:00Z"),
      },
    ]);

    expect(xml).toContain("read_only=true");
    expect(xml).toContain("DO NOT MODIFY");
  });
});
