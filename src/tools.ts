import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";

import type { JournalStore } from "./journal";
import type {
  MemoryBlock,
  MemoryEdit,
  MemoryScope,
  MemoryStore,
  MemoryWriteResult,
} from "./memory";

export type MemoryToolOptions = {
  disableGlobal?: boolean;
};

const labelSchema = {
  type: "string",
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9-_]{1,60}$",
  minLength: 2,
  maxLength: 61,
} as const;

function formatWriteResult(verb: string, result: MemoryWriteResult): { content: string } {
  const base = `${verb} memory block ${result.scope}:${result.label} (chars=${result.chars}/${result.limit}).`;
  const warning = result.overage > 0
    ? ` OVER LIMIT by ${result.overage} chars — compact it or raise its limit before the next snapshot.`
    : "";
  return { content: base + warning };
}

export function MemoryList(store: MemoryStore, opts?: MemoryToolOptions): ToolInfo {
  const disableGlobal = opts?.disableGlobal === true;
  const scopeValues = disableGlobal
    ? (["all", "project"] as const)
    : (["all", "global", "project"] as const);

  return {
    name: "memory_list",
    description: "List available memory blocks (labels, descriptions, sizes).",
    input: {
      type: "object",
      properties: {
        scope: { type: "string", enum: [...scopeValues] },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const args = input as { scope?: MemoryScope | "all" };
      // Default to "all" for list (show everything)
      const scope = (args.scope ?? "all") as MemoryScope | "all";
      const blocks = await store.listBlocks(scope);
      if (blocks.length === 0) {
        return { content: "No memory blocks found." };
      }

      return {
        content: blocks
          .map(
            (b) =>
              `${b.scope}:${b.label}\n  read_only=${b.readOnly} chars=${b.value.length}/${b.limit}\n  ${b.description}`,
          )
          .join("\n\n"),
      };
    },
  };
}

export function MemorySet(store: MemoryStore, opts?: MemoryToolOptions): ToolInfo {
  const disableGlobal = opts?.disableGlobal === true;
  const scopeValues = disableGlobal
    ? (["project"] as const)
    : (["global", "project"] as const);

  return {
    name: "memory_set",
    description:
      "Create or update a memory block (full overwrite). The optional limit is a soft " +
      "in-context budget: exceeding it succeeds but marks the block over_limit. Prefer " +
      "memory_replace for small edits because rewriting a block costs more output tokens.",
    input: {
      type: "object",
      properties: {
        label: labelSchema,
        scope: { type: "string", enum: [...scopeValues] },
        value: { type: "string" },
        description: { type: "string" },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["label", "value"],
      additionalProperties: false,
    },
    async execute(input) {
      const args = input as {
        label: string;
        scope?: MemoryScope;
        value: string;
        description?: string;
        limit?: number;
      };
      // Default to "project" for mutations (safer default)
      const scope = (args.scope ?? "project") as MemoryScope;
      const result = await store.setBlock(scope, args.label, args.value, {
        description: args.description,
        limit: args.limit,
      });
      return formatWriteResult("Updated", result);
    },
  };
}

export function MemoryGet(store: MemoryStore, opts?: MemoryToolOptions): ToolInfo {
  const disableGlobal = opts?.disableGlobal === true;
  const scopeValues = disableGlobal
    ? (["project"] as const)
    : (["global", "project"] as const);

  return {
    name: "memory_get",
    description:
      "Read a memory block's current on-disk value and modification time. Unlike the " +
      "cache-stable session snapshot, this is always fresh. Use it before memory_replace " +
      "when exact oldText is uncertain. Without scope, project is tried before global.",
    input: {
      type: "object",
      properties: {
        label: labelSchema,
        scope: { type: "string", enum: [...scopeValues] },
      },
      required: ["label"],
      additionalProperties: false,
    },
    async execute(input) {
      const args = input as { label: string; scope?: MemoryScope };
      const scopes: MemoryScope[] = args.scope
        ? [args.scope]
        : disableGlobal
          ? ["project"]
          : ["project", "global"];

      let block: MemoryBlock | undefined;
      for (const scope of scopes) {
        try {
          block = await store.getBlock(scope, args.label);
          break;
        } catch (error) {
          if (args.scope) throw error;
        }
      }

      if (!block) {
        throw new Error(`Memory block not found: ${args.label} (scopes tried: ${scopes.join(", ")}).`);
      }

      return {
        content: [
          `${block.scope}:${block.label}`,
          `chars=${block.value.length}/${block.limit} read_only=${block.readOnly}`,
          `last_modified=${block.lastModified.toISOString()}`,
          block.description,
          "",
          block.value,
        ].join("\n"),
      };
    },
  };
}

export function MemoryReplace(store: MemoryStore, opts?: MemoryToolOptions): ToolInfo {
  const disableGlobal = opts?.disableGlobal === true;
  const scopeValues = disableGlobal
    ? (["project"] as const)
    : (["global", "project"] as const);

  return {
    name: "memory_replace",
    description:
      "Replace text within a memory block. Pass oldText/newText for one edit or edits " +
      "for several replacements applied atomically in order. Use memory_get first when " +
      "exact text is uncertain. The optional limit updates the block's soft budget.",
    input: {
      type: "object",
      properties: {
        label: labelSchema,
        scope: { type: "string", enum: [...scopeValues] },
        oldText: { type: "string" },
        newText: { type: "string" },
        edits: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", minLength: 1 },
              newText: { type: "string" },
            },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
        },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["label"],
      additionalProperties: false,
    },
    async execute(input) {
      const args = input as {
        label: string;
        scope?: MemoryScope;
        oldText?: string;
        newText?: string;
        edits?: MemoryEdit[];
        limit?: number;
      };
      // Default to "project" for mutations (safer default)
      const scope = (args.scope ?? "project") as MemoryScope;
      const edits = args.edits?.length
        ? args.edits
        : args.oldText !== undefined && args.newText !== undefined
          ? [{ oldText: args.oldText, newText: args.newText }]
          : undefined;
      if (!edits) {
        throw new Error("memory_replace requires oldText/newText or a non-empty edits array.");
      }
      const result = await store.replaceManyInBlock(scope, args.label, edits, {
        limit: args.limit,
      });
      return formatWriteResult("Updated", result);
    },
  };
}

export function MemoryOversized(store: MemoryStore, opts?: MemoryToolOptions): ToolInfo {
  const disableGlobal = opts?.disableGlobal === true;
  const scopeValues = disableGlobal
    ? (["all", "project"] as const)
    : (["all", "global", "project"] as const);

  return {
    name: "memory_oversized",
    description:
      "List memory blocks close to or over their soft character limit, worst first. " +
      "Returns metadata only, never block contents. Use memory_get and batch memory_replace " +
      "to compact matching blocks.",
    input: {
      type: "object",
      properties: {
        threshold: { type: "number", minimum: 0, maximum: 100 },
        scope: { type: "string", enum: [...scopeValues] },
        name: { type: "string" },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const args = input as {
        threshold?: number;
        scope?: MemoryScope | "all";
        name?: string;
      };
      const threshold = args.threshold ?? 90;
      const scope = args.scope ?? "all";
      const needle = args.name?.trim().toLowerCase();
      let blocks = await store.listBlocks(scope);
      if (needle) blocks = blocks.filter((block) => block.label.toLowerCase().includes(needle));

      const rows = blocks
        .map((block) => ({
          block,
          percent: block.limit > 0 ? (block.value.length / block.limit) * 100 : 0,
          free: Math.max(0, block.limit - block.value.length),
          over: Math.max(0, block.value.length - block.limit),
        }))
        .filter((row) => row.percent >= threshold)
        .sort((a, b) => b.percent - a.percent);

      if (rows.length === 0) {
        return {
          content: `No memory blocks at or above ${threshold}% of their limit (checked ${blocks.length}, scope=${scope}).`,
        };
      }

      const lines = rows.map((row, index) => {
        const block = row.block;
        return [
          `${index + 1}. ${block.scope}:${block.label} — ${row.percent.toFixed(1)}% ` +
            `(chars=${block.value.length}/${block.limit}, free=${row.free}, over=${row.over}) ` +
            `read_only=${block.readOnly}`,
          block.description ? `   ${block.description}` : "",
        ].filter(Boolean).join("\n");
      });
      const overCount = rows.filter((row) => row.over > 0).length;
      return {
        content: [
          `Oversized memory blocks (>= ${threshold}%): ${rows.length} of ${blocks.length}, worst first.`,
          "",
          lines.join("\n"),
          "",
          `Summary: ${overCount} over limit, ${rows.length} at/above threshold.`,
        ].join("\n"),
      };
    },
  };
}

export type JournalContext = {
  directory: string;
  getModel(sessionID: string): { model: string; provider: string } | undefined;
};

export function JournalWrite(
  store: JournalStore,
  ctx: JournalContext,
): ToolInfo {
  return {
    name: "journal_write",
    description:
      "Write a new journal entry. Use this to capture insights, technical discoveries, " +
      "design decisions, observations, or reflections. Entries are append-only and cannot be edited. " +
      "Tags are optional comma-separated names, e.g. \"perf, debugging\".",
    input: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        tags: { type: "string" },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
    async execute(input, toolCtx) {
      const args = input as { title: string; body: string; tags?: string };
      const model = ctx.getModel(String(toolCtx.sessionID));
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
        model: model?.model ?? "",
        provider: model?.provider ?? "",
        agent: toolCtx.agent,
        sessionId: toolCtx.sessionID,
        tags,
      });

      return {
        content: `Journal entry created: ${entry.id}\n  title: ${entry.title}\n  created: ${entry.created.toISOString()}`,
      };
    },
  };
}

export function JournalRead(store: JournalStore): ToolInfo {
  return {
    name: "journal_read",
    description:
      "Read a specific journal entry by its ID. Returns the full entry " +
      "including metadata and body.",
    input: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(input) {
      const args = input as { id: string };
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

      return { content: `${meta}\n\n${entry.body}` };
    },
  };
}

export function JournalSearch(store: JournalStore): ToolInfo {
  return {
    name: "journal_search",
    description:
      "Search journal entries using semantic similarity. Returns matching entries " +
      "sorted by relevance. All filters are optional and combined with AND logic. " +
      "Use with no arguments to list recent entries. Use offset to paginate.",
    input: {
      type: "object",
      properties: {
        text: { type: "string" },
        project: { type: "string" },
        tags: { type: "string" },
        limit: { type: "integer", minimum: 1 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const args = input as {
        text?: string;
        project?: string;
        tags?: string;
        limit?: number;
        offset?: number;
      };
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
        return { content: `No journal entries found.${tagsLine}` };
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

      return { content: `${header}${tagsLine}\n\n${lines.join("\n\n")}` };
    },
  };
}
