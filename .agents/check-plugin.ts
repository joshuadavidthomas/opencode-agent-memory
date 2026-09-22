import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { Info as ToolInfo, ToolContext } from "@opencode/plugin/promise/tool";
import { env } from "@huggingface/transformers";
import MemoryPlugin from "../index";

// Exercise real v2 registrations directly, without an LLM or test mocks.
env.allowRemoteModels = false;
// Bun captures the home directory at startup, so isolation needs a new process.
if (!process.argv.includes("--isolated")) {
  const root = await mkdtemp(join(tmpdir(), "agent-memory-smoke-"));
  let result: number;
  try {
    result = Bun.spawnSync([process.execPath, import.meta.path, "--isolated"], {
      env: { ...process.env, HOME: root },
      stdout: "inherit",
      stderr: "inherit",
    }).exitCode;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  process.exit(result);
}

const root = homedir();
const directory = join(root, "project");
const configDir = join(root, ".config/opencode");
await mkdir(configDir, { recursive: true });
await writeFile(join(configDir, "agent-memory.json"), '{"journal":{"enabled":true}}');

const tools: Record<string, ToolInfo> = {};
let contextHook: ((event: SessionContext) => Promise<void> | void) | undefined;
const context = {
  location: { directory },
  tool: {
    transform: async (transform: (editor: { add(tool: ToolInfo): void }) => void) => {
      transform({ add: (tool) => { tools[tool.name] = tool; } });
    },
  },
  session: {
    context: async () => [],
    hook: async (name: string, hook: (event: SessionContext) => Promise<void> | void) => {
      if (name === "context") contextHook = hook;
    },
  },
  event: {
    subscribe: async function* () {},
  },
} as unknown as Plugin.Context;

await MemoryPlugin.setup(context);
assert.equal(MemoryPlugin.id, "opencode-agent-memory");
assert.deepEqual(Object.keys(tools).sort(), [
  "journal_read",
  "journal_search",
  "journal_write",
  "memory_get",
  "memory_list",
  "memory_oversized",
  "memory_replace",
  "memory_set",
]);
assert.ok(contextHook);

const toolContext = {
  agent: "smoke-agent",
  sessionID: "smoke-session",
  messageID: "smoke-message",
  id: "smoke-call",
  signal: new AbortController().signal,
  progress: async () => {},
} as unknown as ToolContext;

await tools.memory_set!.execute({ label: "orb-check", value: "orb-original-marker" }, toolContext);
await tools.memory_replace!.execute({ label: "orb-check", oldText: "original", newText: "updated" }, toolContext);
const request = {
  sessionID: "smoke-session",
  agent: "smoke-agent",
  model: { id: "smoke-model", providerID: "smoke-provider" },
  system: [
    { type: "text", text: "provider-header" },
    { type: "text", text: "existing-instructions" },
  ],
  messages: [],
  options: {},
  tools: {},
} as unknown as SessionContext;
await contextHook(request);
assert.equal(request.system[0]?.text, "provider-header");
assert.ok(request.system[1]?.text.includes("orb-updated-marker"));
assert.ok(!request.system[1]?.text.includes("orb-original-marker"));
assert.ok(request.system.at(-1)?.text.includes("journal"));
assert.ok(String((await tools.memory_list!.execute({}, toolContext)).content).includes("project:orb-check"));
assert.ok(String((await tools.memory_get!.execute({ label: "orb-check" }, toolContext)).content).includes("orb-updated-marker"));

await tools.journal_write!.execute(
  { title: "Fetch", body: "The puppy chased a ball in the garden." },
  toolContext,
);
const journalDir = join(configDir, "journal");
const filename = (await readdir(journalDir)).find((name) => name.endsWith(".md"))!;
const id = filename.slice(0, -3);
const entry = String((await tools.journal_read!.execute({ id }, toolContext)).content);
for (const value of ["smoke-model", "smoke-provider", "smoke-agent", "smoke-session"]) {
  assert.ok(entry.includes(value));
}
const search = String((await tools.journal_search!.execute({}, toolContext)).content);
assert.ok(search.includes(id));
console.log("Plugin OK: v2 setup, tools, context hook, journal metadata, and journal search");
