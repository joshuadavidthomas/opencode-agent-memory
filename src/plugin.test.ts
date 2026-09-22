import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { Info as ToolInfo, ToolContext } from "@opencode/plugin/promise/tool";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createMemoryStore } from "./memory";
import MemoryPlugin from "../index";

type ContextHook = (event: SessionContext) => Promise<void> | void;

function toolContext(sessionID = "test-session"): ToolContext {
  return {
    sessionID: sessionID as ToolContext["sessionID"],
    messageID: "test-message" as ToolContext["messageID"],
    id: "test-call" as ToolContext["id"],
    agent: "test-agent" as ToolContext["agent"],
    signal: new AbortController().signal,
    progress: async () => {},
  };
}

async function setupPlugin(
  directory: string,
  events?: AsyncIterable<unknown>,
  sessionContexts = new Map<string, unknown[]>(),
) {
  const tools: Record<string, ToolInfo> = {};
  let contextHook: ContextHook | undefined;
  const context = {
    location: { directory },
    tool: {
      transform: async (transform: (editor: { add(tool: ToolInfo): void }) => void) => {
        transform({ add: (tool) => { tools[tool.name] = tool; } });
      },
    },
    session: {
      context: async ({ sessionID }: { sessionID: string }) =>
        sessionContexts.get(String(sessionID)) ?? [],
      hook: async (name: string, hook: ContextHook) => {
        if (name === "context") contextHook = hook;
      },
    },
    event: {
      subscribe: () => events ?? (async function* () {})(),
    },
  } as unknown as Plugin.Context;

  const cleanup = await MemoryPlugin.setup(context);
  if (!contextHook) throw new Error("context hook was not registered");
  return { tools, contextHook, cleanup };
}

function scopeValues(tool: ToolInfo): string[] {
  const input = tool.input as {
    properties?: { scope?: { enum?: string[] } };
  };
  return input.properties?.scope?.enum ?? [];
}

function request(system = [
  { type: "text" as const, text: "provider header" },
  { type: "text" as const, text: "existing instructions" },
], sessionID = "test-session", model = "test-model", provider = "test-provider"): SessionContext {
  return {
    sessionID,
    agent: "test-agent",
    model: { id: model, providerID: provider },
    system,
    messages: [],
    options: {},
    tools: {},
  } as unknown as SessionContext;
}

describe("memory plugin configuration", () => {
  let home: string;
  let directory: string;
  let configDir: string;
  let homedirSpy: { mockRestore(): void };

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

    const { tools, contextHook } = await setupPlugin(directory);
    const event = request();
    await contextHook(event);
    expect(event.system[0]?.text).toBe("provider header");
    expect(event.system[2]?.text).toBe("existing instructions");
    const prompt = event.system[1]?.text ?? "";
    expect(prompt).toContain("PROJECT_ONLY_FIXTURE");
    expect(prompt.includes("GLOBAL_ONLY_FIXTURE")).toBe(globalEnabled);
    expect(prompt.includes("scope=global")).toBe(globalEnabled);
    expect(prompt.includes("Memory blocks have two scopes:")).toBe(globalEnabled);
    expect(prompt.includes("- global:")).toBe(globalEnabled);
    if (!globalEnabled) {
      expect(prompt).toContain("Only project-scoped memory is available");
      await expect(fs.access(path.join(configDir, "memory", "persona.md"))).rejects.toThrow();
    }

    expect(Boolean(tools.journal_write)).toBe(name === "journal enabled");
    expect(tools.memory_get).toBeDefined();
    expect(tools.memory_oversized).toBeDefined();
    if (name === "journal enabled") {
      expect(event.system[3]?.text).toContain("Performance");
    }
    for (const toolName of ["memory_list", "memory_set", "memory_replace"]) {
      const scopes = scopeValues(tools[toolName]!);
      expect(scopes.includes("global")).toBe(globalEnabled);
      expect(scopes).toContain("project");
      expect(scopes.includes("all")).toBe(toolName === "memory_list");
    }
    const listed = await tools.memory_list!.execute({}, toolContext());
    expect(listed.content).toContain("project:human");
    expect(String(listed.content).includes("global:human")).toBe(globalEnabled);

    await tools.memory_set!.execute({ label: "human", value: "Updated project" }, toolContext());
    await tools.memory_replace!.execute({ label: "human", oldText: "Updated", newText: "Revised" }, toolContext());
    expect((await store.getBlock("project", "human")).value).toBe("Revised project");
    if (!globalEnabled) {
      await expect(tools.memory_set!.execute({ scope: "global", label: "human", value: "wrong" }, toolContext()))
        .rejects.toThrow("Global memory scope is disabled");
      await expect(tools.memory_replace!.execute({ scope: "global", label: "human", oldText: "GLOBAL", newText: "wrong" }, toolContext()))
        .rejects.toThrow("Global memory scope is disabled");
    }
    expect(await fs.readFile(globalPath, "utf-8")).toBe(original);
  });

  test("malformed config uses defaults and logs a warning", async () => {
    await fs.writeFile(
      path.join(configDir, "agent-memory.json"),
      '{"memory": {"disable_global": true}',
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { tools } = await setupPlugin(directory);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("global memory enabled"));
    const listed = await tools.memory_list!.execute({}, toolContext());
    expect(listed.content).toContain("global:human");
    expect(listed.content).toContain("project:project");
    expect(scopeValues(tools.memory_set!)).toContain("global");
    warn.mockRestore();
  });

  test("journal writes use metadata from the matching session", async () => {
    await fs.writeFile(
      path.join(configDir, "agent-memory.json"),
      JSON.stringify({ journal: { enabled: true } }),
    );
    const { tools, contextHook } = await setupPlugin(directory);
    await contextHook(request(undefined, "session-a", "model-a", "provider-a"));
    await contextHook(request(undefined, "session-b", "model-b", "provider-b"));

    const result = await tools.journal_write!.execute(
      { title: "Session A", body: "Session-specific metadata" },
      toolContext("session-a"),
    );
    const id = String(result.content).match(/Journal entry created: (\S+)/)?.[1];
    expect(id).toBeDefined();
    const entry = await tools.journal_read!.execute({ id }, toolContext("session-a"));
    expect(entry.content).toContain("model: model-a");
    expect(entry.content).toContain("provider: provider-a");
    expect(entry.content).not.toContain("model-b");
    expect(entry.content).not.toContain("provider-b");
  });

  test("freezes memory per session and refreshes it for a new session", async () => {
    const store = createMemoryStore(directory);
    await store.ensureSeed();
    await store.setBlock("project", "project", "snapshot one");
    const { contextHook } = await setupPlugin(directory);

    const first = request(undefined, "session-a");
    await contextHook(first);
    expect(first.system[1]?.text).toContain("snapshot one");

    await store.setBlock("project", "project", "snapshot two");
    const sameSession = request(undefined, "session-a");
    await contextHook(sameSession);
    expect(sameSession.system[1]?.text).toContain("snapshot one");
    expect(sameSession.system[1]?.text).not.toContain("snapshot two");

    const newSession = request(undefined, "session-b");
    await contextHook(newSession);
    expect(newSession.system[1]?.text).toContain("snapshot two");
  });

  test("refreshes from durable context immediately after compaction", async () => {
    const sessionContexts = new Map<string, unknown[]>();
    const store = createMemoryStore(directory);
    await store.ensureSeed();
    await store.setBlock("project", "project", "before compaction");
    const { contextHook } = await setupPlugin(directory, undefined, sessionContexts);
    const first = request(undefined, "session-a");
    await contextHook(first);
    await store.setBlock("project", "project", "after compaction");

    sessionContexts.set("session-a", [{
      type: "compaction",
      id: "compaction-1",
      status: "completed",
    }]);

    const refreshed = request(undefined, "session-a");
    await contextHook(refreshed);
    expect(refreshed.system[1]?.text).toContain("after compaction");
    expect(refreshed.system[1]?.text).not.toContain("before compaction");
  });

  test("does not reuse a global snapshot after isolation is enabled", async () => {
    const memory = createMemoryStore(directory);
    await memory.setBlock("global", "human", "GLOBAL_SNAPSHOT_FIXTURE");
    await memory.setBlock("project", "human", "PROJECT_SNAPSHOT_FIXTURE");

    const first = await setupPlugin(directory);
    const globalEvent = request(undefined, "session-restarted");
    await first.contextHook(globalEvent);
    expect(globalEvent.system[1]?.text).toContain("GLOBAL_SNAPSHOT_FIXTURE");
    await first.cleanup?.();

    await fs.writeFile(
      path.join(configDir, "agent-memory.json"),
      JSON.stringify({ memory: { disable_global: true } }),
    );
    const restarted = await setupPlugin(directory);
    const isolatedEvent = request(undefined, "session-restarted");
    await restarted.contextHook(isolatedEvent);

    expect(isolatedEvent.system[1]?.text).toContain("PROJECT_SNAPSHOT_FIXTURE");
    expect(isolatedEvent.system[1]?.text).not.toContain("GLOBAL_SNAPSHOT_FIXTURE");
    expect(isolatedEvent.system[1]?.text).toContain("Only project-scoped memory is available");
    await restarted.cleanup?.();
  });

  test("memory can be disabled while journal remains enabled", async () => {
    await fs.writeFile(
      path.join(configDir, "agent-memory.json"),
      JSON.stringify({ memory: { enabled: false }, journal: { enabled: true } }),
    );
    const { tools, contextHook } = await setupPlugin(directory);
    expect(Object.keys(tools).sort()).toEqual([
      "journal_read",
      "journal_search",
      "journal_write",
    ]);
    const event = request();
    await contextHook(event);
    expect(event.system.some((part) => part.text.includes("<memory_blocks>"))).toBe(false);
    expect(event.system.at(-1)?.text).toContain("<journal_instructions>");
    await expect(fs.access(path.join(directory, ".opencode", "memory"))).rejects.toThrow();
  });

  test("invalid memory settings stop initialization before seeding", async () => {
    await fs.writeFile(
      path.join(configDir, "agent-memory.json"),
      JSON.stringify({ memory: { disable_global: "true" } }),
    );
    await expect(setupPlugin(directory)).rejects.toThrow("agent-memory.json");
    await expect(fs.access(path.join(configDir, "memory"))).rejects.toThrow();
    await expect(fs.access(path.join(directory, ".opencode", "memory"))).rejects.toThrow();
  });
});
