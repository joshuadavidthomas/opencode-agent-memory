import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import yaml from "js-yaml";
import { z } from "zod";

import { cosineSimilarity, generateEmbedding } from "./embeddings";
import { atomicWriteFile, buildFrontmatterDocument, splitFrontmatter } from "./frontmatter";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ConfigSchema = z.looseObject({
  journal: z
    .looseObject({
      enabled: z.boolean().optional(),
      categories: z.array(z.string().min(1)).optional(),
    })
    .optional(),
});

export type AgentMemoryConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(
  configDir?: string,
): Promise<AgentMemoryConfig> {
  const dir = configDir ?? path.join(os.homedir(), ".config", "opencode");
  const configPath = path.join(dir, "agent-memory.json");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = ConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return {};
    return parsed.data;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Journal entry types
// ---------------------------------------------------------------------------

export const DEFAULT_CATEGORIES = [
  "insight",
  "decision",
  "observation",
  "reflection",
  "note",
] as const;

const EntryFrontmatterSchema = z.looseObject({
  title: z.string().min(1),
  category: z.string().optional(),
  project: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  agent: z.string().optional(),
  session_id: z.string().optional(),
  created: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export type JournalEntry = {
  id: string;
  title: string;
  category: string;
  project: string;
  model: string;
  provider: string;
  agent: string;
  sessionId: string;
  created: Date;
  tags: string[];
  body: string;
  filePath: string;
};

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function entryFilename(date: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return [
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`,
    "-",
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`,
    "-",
    `${pad(date.getUTCMilliseconds(), 3)}`,
    ".md",
  ].join("");
}

function embeddingPath(entryPath: string): string {
  return entryPath.replace(/\.md$/, ".embedding");
}

async function readEntryFile(filePath: string): Promise<JournalEntry> {
  const raw = await fs.readFile(filePath, "utf-8");
  const { frontmatterText, body } = splitFrontmatter(raw);

  if (!frontmatterText) {
    throw new Error(`Journal entry missing frontmatter: ${filePath}`);
  }

  const loaded = yaml.load(frontmatterText);
  const parsed = EntryFrontmatterSchema.safeParse(loaded);
  if (!parsed.success) {
    throw new Error(`Invalid journal frontmatter in ${filePath}: ${parsed.error.message}`);
  }

  const fm = parsed.data;
  const id = path.basename(filePath, ".md");

  return {
    id,
    title: fm.title,
    category: fm.category ?? "note",
    project: fm.project ?? "",
    model: fm.model ?? "",
    provider: fm.provider ?? "",
    agent: fm.agent ?? "",
    sessionId: fm.session_id ?? "",
    created: fm.created ? new Date(fm.created) : new Date(),
    tags: fm.tags ?? [],
    body: body.trim(),
    filePath,
  };
}

async function loadEmbedding(entryPath: string): Promise<number[] | undefined> {
  const ePath = embeddingPath(entryPath);
  try {
    const raw = await fs.readFile(ePath, "utf-8");
    return JSON.parse(raw) as number[];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// ID validation
// ---------------------------------------------------------------------------

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function validateId(id: string): string {
  const trimmed = id.trim();
  if (!SAFE_ID.test(trimmed)) {
    throw new Error(`Invalid journal entry ID: "${id}"`);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Journal store
// ---------------------------------------------------------------------------

export type JournalStore = {
  write(entry: {
    title: string;
    body: string;
    category?: string;
    project?: string;
    model?: string;
    provider?: string;
    agent?: string;
    sessionId?: string;
    tags?: string[];
  }): Promise<JournalEntry>;

  read(id: string): Promise<JournalEntry>;

  search(query: {
    text?: string;
    category?: string;
    project?: string;
    tags?: string[];
    limit?: number;
  }): Promise<{ entries: JournalEntry[]; total: number }>;
};

export function createJournalStore(configDir?: string): JournalStore {
  const journalDir = path.join(
    configDir ?? path.join(os.homedir(), ".config", "opencode"),
    "journal",
  );

  return {
    async write(entry) {
      await fs.mkdir(journalDir, { recursive: true });

      const created = new Date();
      const category = entry.category ?? "note";
      const filename = entryFilename(created);
      const filePath = path.join(journalDir, filename);

      const frontmatter: Record<string, unknown> = {
        title: entry.title,
        category,
        created: created.toISOString(),
      };

      if (entry.project) frontmatter.project = entry.project;
      if (entry.model) frontmatter.model = entry.model;
      if (entry.provider) frontmatter.provider = entry.provider;
      if (entry.agent) frontmatter.agent = entry.agent;
      if (entry.sessionId) frontmatter.session_id = entry.sessionId;
      if (entry.tags && entry.tags.length > 0) frontmatter.tags = entry.tags;

      const content = buildFrontmatterDocument(frontmatter, entry.body);
      await atomicWriteFile(filePath, content);

      // Generate and save embedding for semantic search
      const searchableText = `${entry.title}\n${entry.body}`;
      try {
        const embedding = await generateEmbedding(searchableText);
        await fs.writeFile(
          embeddingPath(filePath),
          JSON.stringify(embedding),
          "utf-8",
        );
      } catch {
        // Embedding generation can fail (e.g. model download issue).
        // The entry is still saved; text search remains available.
      }

      return {
        id: path.basename(filePath, ".md"),
        title: entry.title,
        category,
        project: entry.project ?? "",
        model: entry.model ?? "",
        provider: entry.provider ?? "",
        agent: entry.agent ?? "",
        sessionId: entry.sessionId ?? "",
        created,
        tags: entry.tags ?? [],
        body: entry.body,
        filePath,
      };
    },

    async read(id) {
      const safeId = validateId(id);
      const filePath = path.join(journalDir, `${safeId}.md`);

      try {
        await fs.access(filePath);
      } catch {
        throw new Error(`Journal entry not found: ${safeId}`);
      }

      return readEntryFile(filePath);
    },

    async search(query) {
      const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);

      let entries: { entry: JournalEntry; score: number }[] = [];

      // Read all entry files
      let files: string[];
      try {
        const dirEntries = await fs.readdir(journalDir, {
          withFileTypes: true,
        });
        files = dirEntries
          .filter((e) => e.isFile() && e.name.endsWith(".md"))
          .map((e) => e.name)
          .sort()
          .reverse(); // Newest first
      } catch {
        return { entries: [], total: 0 };
      }

      // If a text query is provided, try semantic search first
      let queryEmbedding: number[] | undefined;
      if (query.text) {
        try {
          queryEmbedding = await generateEmbedding(query.text);
        } catch {
          // Fall back to text search if embedding fails
        }
      }

      for (const file of files) {
        const filePath = path.join(journalDir, file);
        let entry: JournalEntry;
        try {
          entry = await readEntryFile(filePath);
        } catch {
          continue;
        }

        // Apply metadata filters (AND logic)
        if (
          query.category &&
          entry.category.toLowerCase() !== query.category.toLowerCase()
        ) {
          continue;
        }
        if (query.project && entry.project !== query.project) {
          continue;
        }
        if (query.tags && query.tags.length > 0) {
          const entryTagsLower = entry.tags.map((t) => t.toLowerCase());
          const allTagsMatch = query.tags.every((t) =>
            entryTagsLower.includes(t.toLowerCase()),
          );
          if (!allTagsMatch) continue;
        }

        // Score the entry
        let score = 0;

        if (query.text) {
          if (queryEmbedding) {
            // Semantic search
            const entryEmbedding = await loadEmbedding(filePath);
            if (entryEmbedding) {
              score = cosineSimilarity(queryEmbedding, entryEmbedding);
            } else {
              // No embedding stored; fall back to text match
              const haystack =
                `${entry.title}\n${entry.body}`.toLowerCase();
              score = haystack.includes(query.text.toLowerCase()) ? 0.5 : 0;
            }
          } else {
            // Text search fallback
            const haystack = `${entry.title}\n${entry.body}`.toLowerCase();
            score = haystack.includes(query.text.toLowerCase()) ? 1 : 0;
          }

          if (score <= 0) continue;
        } else {
          // No text query - chronological order (score by recency)
          score = entry.created.getTime();
        }

        entries.push({ entry, score });
      }

      const total = entries.length;

      // Sort by score descending
      entries.sort((a, b) => b.score - a.score);

      // Apply limit
      entries = entries.slice(0, limit);

      return { entries: entries.map((e) => e.entry), total };
    },
  };
}

// ---------------------------------------------------------------------------
// System prompt note
// ---------------------------------------------------------------------------

export function buildJournalSystemNote(categories: readonly string[]): string {
  const categoryList = categories
    .map((c) => `- ${c}`)
    .join("\n");

  return `<journal_instructions>
You have access to a private journal. Use it to record thoughts, discoveries, and decisions as you work.

Available categories:
${categoryList}

Journal entries are append-only: you write new entries but never edit old ones.
Use journal_search to find past entries semantically, and journal_read to read a specific entry.
The journal is global across all projects but each entry records which project it was written from.
</journal_instructions>`;
}
