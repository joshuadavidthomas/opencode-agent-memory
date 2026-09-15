import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { tool, type PluginInput } from "@opencode-ai/plugin";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createMemoryStore } from "./memory";
import { MemoryPlugin } from "./plugin";

describe("memory plugin configuration", () => {
  let home: string;
  let directory: string;
  let configDir: string;
  let homedirSpy: { mockRestore(): void };
  const context = {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test-agent",
    abort: new AbortController().signal,
  };

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join("/tmp/", "opencode-plugin-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
    directory = path.join(home, "project");
    configDir = path.join(home, ".config", "opencode");
    await fs.mkdir(configDir, { recursive: true });
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fs.rm(home, { recursive: true, force: true });
  });

  test.each([
    ["omitted", {}, true],
    ["false", { memory: { disable_global: false } }, true],
    ["true", { memory: { disable_global: true } }, false],
    ["invalid journal", {
      memory: { disable_global: true },
      journal: { enabled: true, tags: [{ name: "perf" }] },
    }, false],
    ["journal enabled", {
      memory: { disable_global: true },
      journal: { enabled: true, tags: [{ name: "perf", description: "Performance" }] },
    }, false],
  ] as const)("keeps prompts, tools, and storage consistent: %s", async (name, config, globalEnabled) => {
    await fs.writeFile(path.join(configDir, "agent-memory.json"), JSON.stringify(config));
    const store = createMemoryStore(directory);
    await store.setBlock("global", "human", "GLOBAL_ONLY_FIXTURE");
    await store.setBlock("project", "human", "PROJECT_ONLY_FIXTURE");
    const globalPath = path.join(configDir, "memory", "human.md");
    const original = await fs.readFile(globalPath, "utf-8");

    const hooks = await MemoryPlugin({ directory } as PluginInput);
    const output = { system: ["provider header", "existing instructions"] };
    await hooks["experimental.chat.system.transform"]!({}, output);
    expect(output.system[0]).toBe("provider header");
    expect(output.system[2]).toBe("existing instructions");
    const prompt = output.system[1]!;
    expect(prompt).toContain("PROJECT_ONLY_FIXTURE");
    expect(prompt.includes("GLOBAL_ONLY_FIXTURE")).toBe(globalEnabled);
    expect(prompt.includes("scope=global")).toBe(globalEnabled);
    expect(prompt.includes("Memory blocks have two scopes:")).toBe(globalEnabled);
    expect(prompt.includes("- global:")).toBe(globalEnabled);
    if (!globalEnabled) {
      expect(prompt).toContain("Only project-scoped memory is available");
      await expect(fs.access(path.join(configDir, "memory", "persona.md"))).rejects.toThrow();
    }

    const tools = hooks.tool!;
    expect(Boolean(tools.journal_write)).toBe(name === "journal enabled");
    if (name === "journal enabled") {
      expect(output.system[3]).toContain("Performance");
    }
    for (const toolName of ["memory_list", "memory_set", "memory_replace"]) {
      const scope = tools[toolName]!.args.scope!;
      expect(tool.schema.safeParse(scope, "global").success).toBe(globalEnabled);
      expect(tool.schema.safeParse(scope, "project").success).toBe(true);
      expect(tool.schema.safeParse(scope, undefined).success).toBe(true);
      expect(tool.schema.safeParse(scope, "all").success).toBe(toolName === "memory_list");
    }
    const listed = await tools.memory_list!.execute({}, context);
    expect(listed).toContain("project:human");
    expect(listed.includes("global:human")).toBe(globalEnabled);

    await tools.memory_set!.execute({ label: "human", value: "Updated project" }, context);
    await tools.memory_replace!.execute({ label: "human", oldText: "Updated", newText: "Revised" }, context);
    expect((await store.getBlock("project", "human")).value).toBe("Revised project");
    if (!globalEnabled) {
      await expect(tools.memory_set!.execute({ scope: "global", label: "human", value: "wrong" }, context))
        .rejects.toThrow("Global memory scope is disabled");
      await expect(tools.memory_replace!.execute({ scope: "global", label: "human", oldText: "GLOBAL", newText: "wrong" }, context))
        .rejects.toThrow("Global memory scope is disabled");
    }
    expect(await fs.readFile(globalPath, "utf-8")).toBe(original);
  });

  test("invalid memory settings stop initialization before seeding", async () => {
    await fs.writeFile(
      path.join(configDir, "agent-memory.json"),
      JSON.stringify({ memory: { disable_global: "true" } }),
    );
    await expect(MemoryPlugin({ directory } as PluginInput)).rejects.toThrow("agent-memory.json");
    await expect(fs.access(path.join(configDir, "memory"))).rejects.toThrow();
    await expect(fs.access(path.join(directory, ".opencode", "memory"))).rejects.toThrow();
  });
});
