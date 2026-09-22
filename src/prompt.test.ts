import { describe, expect, test } from "bun:test";

import type { MemoryBlock } from "./memory";
import { renderMemoryBlocks } from "./prompt";

describe("renderMemoryBlocks", () => {
  test("renders stable xml with line numbers", () => {
    const xml = renderMemoryBlocks([
      {
        scope: "global",
        label: "human",
        description: "User prefs",
        limit: 10,
        readOnly: false,
        value: "line one\nline two",
        filePath: "/tmp/human.md",
        lastModified: new Date("2025-01-15T10:30:00Z"),
      },
    ]);

    expect(xml).toContain("<memory_blocks>");
    expect(xml).toContain("The following memory blocks are currently engaged");
    expect(xml).toContain("<human>");
    expect(xml).toContain("<warning>");
    expect(xml).toContain("Do NOT include line number prefixes");
    expect(xml).toContain("1→ line one");
    expect(xml).toContain("2→ line two");
  });

  test("includes memory instructions section", () => {
    const xml = renderMemoryBlocks([
      {
        scope: "global",
        label: "human",
        description: "User prefs",
        limit: 10,
        readOnly: false,
        value: "hi",
        filePath: "/tmp/human.md",
        lastModified: new Date("2025-01-15T10:30:00Z"),
      },
    ]);

    expect(xml).toContain("<memory_instructions>");
    expect(xml).toContain("<memory_editing>");
    expect(xml).toContain("persistent memory");
    expect(xml).toContain("<memory_scopes>");
    expect(xml).toContain("</memory_instructions>");
  });

  test("renders cache-stable metadata without request timestamps", () => {
    const blocks: MemoryBlock[] = [
      {
        scope: "global",
        label: "human",
        description: "User prefs",
        limit: 10,
        readOnly: false,
        value: "hi",
        filePath: "/tmp/human.md",
        lastModified: new Date("2025-01-15T10:30:00Z"),
      },
    ];
    const first = renderMemoryBlocks(blocks);
    const second = renderMemoryBlocks(blocks);

    expect(first).toContain("<memory_metadata>");
    expect(first).not.toContain("The current system date is:");
    expect(first).not.toContain("Memory blocks were last modified:");
    expect(second).toBe(first);
  });

  test("marks blocks that exceed their soft limit", () => {
    const xml = renderMemoryBlocks([
      {
        scope: "project",
        label: "notes",
        description: "Notes",
        limit: 3,
        readOnly: false,
        value: "hello",
        filePath: "/tmp/notes.md",
        lastModified: new Date("2025-01-15T10:30:00Z"),
      },
    ]);

    expect(xml).toContain("over_limit=true (over=2 chars)");
    expect(xml).toContain("This block is OVER its chars_limit");
  });

  test("handles empty value gracefully", () => {
    const xml = renderMemoryBlocks([
      {
        scope: "project",
        label: "notes",
        description: "Project notes",
        limit: 1000,
        readOnly: false,
        value: "",
        filePath: "/tmp/notes.md",
        lastModified: new Date("2025-01-15T10:30:00Z"),
      },
    ]);

    expect(xml).toContain("<notes>");
    expect(xml).toContain("<value>\n\n</value>");
    // Available scopes come from configuration, not the blocks currently present.
    expect(xml).toContain("Memory blocks have two scopes:");
    expect(xml).toContain("- global:");
    // Empty value - the value section should be truly empty
    const valueMatch = xml.match(/<value>\n(.*?)\n<\/value>/s);
    expect(valueMatch).toBeTruthy();
    expect(valueMatch![1]).toBe("");
  });

  test("renders complete output structure", () => {
    const xml = renderMemoryBlocks([
      {
        scope: "global",
        label: "persona",
        description: "Your persona",
        limit: 5000,
        readOnly: false,
        value: "I am helpful\nand concise",
        filePath: "/tmp/persona.md",
        lastModified: new Date("2025-01-15T08:00:00Z"),
      },
      {
        scope: "project",
        label: "project",
        description: "Project info",
        limit: 5000,
        readOnly: true,
        value: "This is a TypeScript project",
        filePath: "/tmp/project.md",
        lastModified: new Date("2025-01-15T10:30:00Z"),
      },
    ]);

    // Check overall structure order
    const instructionsIndex = xml.indexOf("<memory_instructions>");
    const blocksIndex = xml.indexOf("<memory_blocks>");
    const metadataIndex = xml.indexOf("<memory_metadata>");

    expect(instructionsIndex).toBeLessThan(blocksIndex);
    expect(blocksIndex).toBeLessThan(metadataIndex);

    // Check both blocks present
    expect(xml).toContain("<persona>");
    expect(xml).toContain("</persona>");
    expect(xml).toContain("<project>");
    expect(xml).toContain("</project>");

    // Check line numbers in multi-line value
    expect(xml).toContain("1→ I am helpful");
    expect(xml).toContain("2→ and concise");

    // Check read_only rendered
    expect(xml).toContain("read_only=true");
    expect(xml).toContain("read_only=false");
  });
});
