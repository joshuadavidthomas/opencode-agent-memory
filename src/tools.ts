import { tool } from "@opencode-ai/plugin";

import type { JournalStore } from "./journal";
import type {
  MemoryBlock,
  MemoryEdit,
  MemoryScope,
  MemoryStore,
  MemoryWriteResult,
} from "./memory";

function formatWriteResult(verb: string, result: MemoryWriteResult): string {
  const base = `${verb} memory block ${result.scope}:${result.label} (chars=${result.chars}/${result.limit}).`;
  if (result.overage > 0) {
    return `${base} OVER LIMIT by ${result.overage} chars — it will render marked over_limit until compacted. Trim it or raise its limit.`;
  }
  return base;
}

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
    description:
      "Create or update a memory block (full overwrite). " +
      "The optional `limit` sets the block's in-context budget (default 5000 chars). " +
      "Exceeding it does NOT fail the write: the block is marked over_limit at render time until compacted. " +
      "Prefer memory_replace for small edits — rewriting a whole block costs many output tokens.",
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
      const result = await store.setBlock(scope, args.label, args.value, {
        description: args.description,
        limit: args.limit,
      });
      return formatWriteResult("Updated", result);
    },
  });
}

export function MemoryGet(store: MemoryStore) {
  return tool({
    description:
      "Read the current on-disk value of a memory block. Unlike the session snapshot " +
      "(frozen for prompt caching), this is always fresh. Use it to build exact oldText " +
      "for memory_replace and to confirm the result after an edit. If scope is omitted, " +
      "the project scope is tried first, then global.",
    args: {
      label: tool.schema.string(),
      scope: tool.schema.enum(["global", "project"]).optional(),
    },
    async execute(args) {
      const scopes: MemoryScope[] = args.scope
        ? [args.scope as MemoryScope]
        : ["project", "global"];

      let block: MemoryBlock | undefined;
      for (const scope of scopes) {
        try {
          block = await store.getBlock(scope, args.label);
          break;
        } catch {
          // try next scope
        }
      }

      if (!block) {
        return `Memory block not found: ${args.label} (scopes tried: ${scopes.join(", ")}).`;
      }

      return [
        `${block.scope}:${block.label}`,
        `chars=${block.value.length}/${block.limit} read_only=${block.readOnly}`,
        block.description,
        "",
        block.value,
      ].join("\n");
    },
  });
}

export function MemoryReplace(store: MemoryStore) {
  return tool({
    description:
      "Replace text within a memory block. Two modes: a single (oldText, newText) pair, " +
      "or `edits` with several {oldText,newText} pairs applied in order in ONE call — use " +
      "the batch form to drop superseded lines and add new ones together, even on a full block. " +
      "oldText must match exactly (use memory_get first if unsure). The chars_limit is soft: " +
      "growing a block past it succeeds and is marked over_limit at render time. " +
      "Optional `limit` updates the block's budget.",
    args: {
      label: tool.schema.string(),
      scope: tool.schema.enum(["global", "project"]).optional(),
      oldText: tool.schema.string().optional(),
      newText: tool.schema.string().optional(),
      edits: tool.schema
        .array(
          tool.schema.object({
            oldText: tool.schema.string(),
            newText: tool.schema.string(),
          }),
        )
        .optional(),
      limit: tool.schema.number().int().positive().optional(),
    },
    async execute(args) {
      // Default to "project" for mutations (safer default)
      const scope = (args.scope ?? "project") as MemoryScope;

      let edits: MemoryEdit[];
      if (args.edits && args.edits.length > 0) {
        edits = args.edits;
      } else if (args.oldText !== undefined && args.newText !== undefined) {
        edits = [{ oldText: args.oldText, newText: args.newText }];
      } else {
        return "memory_replace needs either (oldText, newText) or a non-empty edits array.";
      }

      const result = await store.replaceManyInBlock(scope, args.label, edits, {
        limit: args.limit,
      });
      return formatWriteResult("Updated", result);
    },
  });
}

export type JournalContext = {
  directory: string;
  model: string;
  provider: string;
};

export function JournalWrite(
  store: JournalStore,
  ctx: JournalContext,
) {
  return tool({
    description:
      "Write a new journal entry. Use this to capture insights, technical discoveries, " +
      "design decisions, observations, or reflections. Entries are append-only and cannot be edited. " +
      "Tags are optional comma-separated names, e.g. \"perf, debugging\".",
    args: {
      title: tool.schema.string(),
      body: tool.schema.string(),
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
        project: ctx.directory,
        model: ctx.model,
        provider: ctx.provider,
        agent: toolCtx.agent,
        sessionId: toolCtx.sessionID,
        tags,
      });

      return `Journal entry created: ${entry.id}\n  title: ${entry.title}\n  created: ${entry.created.toISOString()}`;
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

export function JournalSearch(store: JournalStore) {
  return tool({
    description:
      "Search journal entries using semantic similarity. Returns matching entries " +
      "sorted by relevance. All filters are optional and combined with AND logic. " +
      "Use with no arguments to list recent entries. Use offset to paginate.",
    args: {
      text: tool.schema.string().optional(),
      project: tool.schema.string().optional(),
      tags: tool.schema.string().optional(),
      limit: tool.schema.number().int().positive().optional(),
      offset: tool.schema.number().int().nonnegative().optional(),
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
        project: args.project,
        tags,
        limit: args.limit,
        offset: args.offset,
      });

      if (result.entries.length === 0) {
        const tagsLine =
          result.allTags.length > 0
            ? `\nTags in use: ${result.allTags.join(", ")}`
            : "";
        return `No journal entries found.${tagsLine}`;
      }

      const offset = args.offset ?? 0;
      const header = `Found ${result.total} entries (showing ${offset + 1}–${offset + result.entries.length}):`;
      const tagsLine =
        result.allTags.length > 0
          ? `\nTags in use: ${result.allTags.join(", ")}`
          : "";

      const lines = result.entries.map((e) => {
        const tagStr =
          e.tags.length > 0
            ? ` [${e.tags.join(", ")}]`
            : "";
        return `${e.id}\n  ${e.title}${tagStr}\n  ${e.created.toISOString()}`;
      });

      return `${header}${tagsLine}\n\n${lines.join("\n\n")}`;
    },
  });
}
