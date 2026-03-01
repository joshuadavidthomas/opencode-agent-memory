import { tool } from "@opencode-ai/plugin";

import type { JournalStore } from "./journal";
import type { MemoryScope, MemoryStore } from "./memory";

// ---------------------------------------------------------------------------
// Memory tools
// ---------------------------------------------------------------------------

export function MemoryList(store: MemoryStore) {
  return tool({
    description: "List available memory blocks (labels, descriptions, sizes).",
    args: {
      scope: tool.schema.enum(["all", "global", "project"]).optional(),
    },
    async execute(args) {
      // Default to "all" for list (show everything)
      const scope = (args.scope ?? "all") as MemoryScope | "all";
      const blocks = await store.listBlocks(scope);
      if (blocks.length === 0) {
        return "No memory blocks found.";
      }

      return blocks
        .map(
          (b) =>
            `${b.scope}:${b.label}\n  read_only=${b.readOnly} chars=${b.value.length}/${b.limit}\n  ${b.description}`,
        )
        .join("\n\n");
    },
  });
}

export function MemorySet(store: MemoryStore) {
  return tool({
    description: "Create or update a memory block (full overwrite).",
    args: {
      label: tool.schema.string(),
      scope: tool.schema.enum(["global", "project"]).optional(),
      value: tool.schema.string(),
      description: tool.schema.string().optional(),
      limit: tool.schema.number().int().positive().optional(),
    },
    async execute(args) {
      // Default to "project" for mutations (safer default)
      const scope = (args.scope ?? "project") as MemoryScope;
      await store.setBlock(scope, args.label, args.value, {
        description: args.description,
        limit: args.limit,
      });
      return `Updated memory block ${scope}:${args.label}.`;
    },
  });
}

export function MemoryReplace(store: MemoryStore) {
  return tool({
    description: "Replace a substring within a memory block.",
    args: {
      label: tool.schema.string(),
      scope: tool.schema.enum(["global", "project"]).optional(),
      oldText: tool.schema.string(),
      newText: tool.schema.string(),
    },
    async execute(args) {
      // Default to "project" for mutations (safer default)
      const scope = (args.scope ?? "project") as MemoryScope;
      await store.replaceInBlock(scope, args.label, args.oldText, args.newText);
      return `Updated memory block ${scope}:${args.label}.`;
    },
  });
}

// ---------------------------------------------------------------------------
// Journal tools
// ---------------------------------------------------------------------------

export type JournalContext = {
  directory: string;
  model: string;
  provider: string;
};

export function JournalWrite(
  store: JournalStore,
  ctx: JournalContext,
  categories: readonly string[],
) {
  return tool({
    description:
      "Write a new journal entry. Use this to capture insights, technical discoveries, " +
      "design decisions, observations, or reflections. Entries are append-only and cannot be edited. " +
      "Tags are optional comma-separated names, e.g. \"perf, debugging\".",
    args: {
      title: tool.schema.string(),
      body: tool.schema.string(),
      category: tool.schema
        .enum(categories as [string, ...string[]])
        .optional(),
      tags: tool.schema.string().optional(),
    },
    async execute(args, toolCtx) {
      const tags = args.tags
        ? args.tags
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean)
        : undefined;

      const entry = await store.write({
        title: args.title,
        body: args.body,
        category: args.category,
        project: ctx.directory,
        model: ctx.model,
        provider: ctx.provider,
        agent: toolCtx.agent,
        sessionId: toolCtx.sessionID,
        tags,
      });

      return `Journal entry created: ${entry.id}\n  title: ${entry.title}\n  category: ${entry.category}\n  created: ${entry.created.toISOString()}`;
    },
  });
}

export function JournalRead(store: JournalStore) {
  return tool({
    description:
      "Read a specific journal entry by its ID. Returns the full entry " +
      "including metadata and body.",
    args: {
      id: tool.schema.string(),
    },
    async execute(args) {
      const entry = await store.read(args.id);

      const meta = [
        `title: ${entry.title}`,
        `category: ${entry.category}`,
        `created: ${entry.created.toISOString()}`,
        entry.project ? `project: ${entry.project}` : null,
        entry.model ? `model: ${entry.model}` : null,
        entry.provider ? `provider: ${entry.provider}` : null,
        entry.agent ? `agent: ${entry.agent}` : null,
        entry.sessionId ? `session: ${entry.sessionId}` : null,
        entry.tags.length > 0
          ? `tags: ${entry.tags.join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");

      return `${meta}\n\n${entry.body}`;
    },
  });
}

export function JournalSearch(
  store: JournalStore,
  categories: readonly string[],
) {
  return tool({
    description:
      "Search journal entries using semantic similarity. Returns matching entries " +
      "sorted by relevance. All filters are optional and combined with AND logic. " +
      "Use with no arguments to list recent entries.",
    args: {
      text: tool.schema.string().optional(),
      category: tool.schema
        .enum(categories as [string, ...string[]])
        .optional(),
      project: tool.schema.string().optional(),
      tags: tool.schema.string().optional(),
      limit: tool.schema.number().int().positive().optional(),
    },
    async execute(args) {
      const tags = args.tags
        ? args.tags
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean)
        : undefined;

      const result = await store.search({
        text: args.text,
        category: args.category,
        project: args.project,
        tags,
        limit: args.limit,
      });

      if (result.entries.length === 0) {
        const tagsLine =
          result.allTags.length > 0
            ? `\nTags in use: ${result.allTags.join(", ")}`
            : "";
        return `No journal entries found.${tagsLine}`;
      }

      const header = `Found ${result.total} entries (showing ${result.entries.length}):`;
      const tagsLine =
        result.allTags.length > 0
          ? `\nTags in use: ${result.allTags.join(", ")}`
          : "";

      const lines = result.entries.map((e) => {
        const tagStr =
          e.tags.length > 0
            ? ` [${e.tags.join(", ")}]`
            : "";
        return `${e.id}\n  ${e.category}: ${e.title}${tagStr}\n  ${e.created.toISOString()}`;
      });

      return `${header}${tagsLine}\n\n${lines.join("\n\n")}`;
    },
  });
}
