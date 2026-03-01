import { tool } from "@opencode-ai/plugin";

import type { JournalStore } from "./journal";

export type JournalContext = {
  directory: string;
  model: string;
  provider: string;
};

export function JournalWrite(store: JournalStore, ctx: JournalContext) {
  return tool({
    description:
      "Write a new journal entry. Use this to capture insights, technical discoveries, " +
      "design decisions, observations, or reflections. Entries are append-only and cannot be edited.",
    args: {
      title: tool.schema.string(),
      body: tool.schema.string(),
      category: tool.schema
        .enum(["insight", "decision", "observation", "reflection", "note"])
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
        entry.tags.length > 0 ? `tags: ${entry.tags.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      return `${meta}\n\n${entry.body}`;
    },
  });
}

export function JournalSearch(store: JournalStore) {
  return tool({
    description:
      "Search journal entries using semantic similarity. Returns matching entries " +
      "sorted by relevance. All filters are optional and combined with AND logic. " +
      "Use with no arguments to list recent entries.",
    args: {
      text: tool.schema.string().optional(),
      category: tool.schema
        .enum(["insight", "decision", "observation", "reflection", "note"])
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
        return "No journal entries found.";
      }

      const header = `Found ${result.total} entries (showing ${result.entries.length}):`;

      const lines = result.entries.map((e) => {
        const tagStr = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
        return `${e.id}\n  ${e.category}: ${e.title}${tagStr}\n  ${e.created.toISOString()}`;
      });

      return `${header}\n\n${lines.join("\n\n")}`;
    },
  });
}
