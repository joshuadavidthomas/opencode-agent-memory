import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import yaml from "js-yaml";
import { z } from "zod";

import { atomicWriteFile, buildFrontmatterDocument, splitFrontmatter } from "./frontmatter";
import { getDefaultDescription } from "./letta";

export type MemoryScope = "global" | "project";

export type MemoryBlock = {
  scope: MemoryScope;
  label: string;
  description: string;
  limit: number;
  readOnly: boolean;
  value: string;
  filePath: string;
  lastModified: Date;
};


const FrontmatterSchema = z.looseObject({
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  limit: z.number().int().positive().optional(),
  read_only: z.boolean().optional(),
});

type ParsedFrontmatter = z.infer<typeof FrontmatterSchema>;

function parseFrontmatter(frontmatterText: string | undefined): ParsedFrontmatter {
  if (!frontmatterText) {
    return {};
  }

  const loaded = yaml.load(frontmatterText);
  const parsed = FrontmatterSchema.safeParse(loaded);
  if (!parsed.success) {
    throw new Error(`Invalid frontmatter: ${parsed.error.message}`);
  }

  return parsed.data;
}

const DEFAULT_LIMIT = 5000;

async function readBlockFile(
  scope: MemoryScope,
  filePath: string,
): Promise<MemoryBlock> {
  const [raw, stats] = await Promise.all([
    fs.readFile(filePath, "utf-8"),
    fs.stat(filePath),
  ]);
  const { frontmatterText, body } = splitFrontmatter(raw);
  const fm = parseFrontmatter(frontmatterText);

  const label = (fm.label ?? path.basename(filePath, path.extname(filePath))).trim();
  const description = (fm.description && fm.description.trim().length > 0
    ? fm.description
    : getDefaultDescription(label)).trim();
  const limit = fm.limit ?? DEFAULT_LIMIT;
  const readOnly = (fm.read_only ?? false) === true;

  return {
    scope,
    label,
    description,
    limit,
    readOnly,
    value: body.trim(),
    filePath,
    lastModified: stats.mtime,
  };
}

async function writeBlockFile(
  filePath: string,
  block: Pick<MemoryBlock, "label" | "description" | "limit" | "readOnly" | "value">,
): Promise<void> {
  const content = buildFrontmatterDocument(
    {
      label: block.label,
      description: block.description,
      limit: block.limit,
      read_only: block.readOnly,
    },
    block.value,
  );

  await atomicWriteFile(filePath, content);
}

function validateLabel(label: string): string {
  const trimmed = label.trim();
  if (!/^[a-z0-9][a-z0-9-_]{1,60}$/i.test(trimmed)) {
    throw new Error(
      `Invalid label "${label}". Use letters/numbers/dash/underscore (2-61 chars).`,
    );
  }
  return trimmed;
}

/**
 * Rich "old text not found" error. Returning the current value inline turns a
 * blind retry (re-reading a huge context) into a single self-correcting step.
 */
function notFoundError(
  scope: MemoryScope,
  label: string,
  current: string,
  oldText: string,
  editIndex?: number,
): Error {
  const which = editIndex === undefined ? "" : ` (edit #${editIndex + 1})`;
  return new Error(
    `Old text not found in ${scope}:${label}${which}.\n` +
      `Searched for:\n${oldText}\n\n` +
      `Current value of ${scope}:${label} (chars=${current.length}):\n${current}`,
  );
}

export type MemoryWriteResult = {
  scope: MemoryScope;
  label: string;
  chars: number;
  limit: number;
  /** chars above the limit (0 when within budget). The write still succeeds. */
  overage: number;
};

export type MemoryEdit = { oldText: string; newText: string };

export type MemoryStore = {
  ensureSeed(): Promise<void>;
  listBlocks(scope: MemoryScope | "all"): Promise<MemoryBlock[]>;
  getBlock(scope: MemoryScope, label: string): Promise<MemoryBlock>;
  setBlock(
    scope: MemoryScope,
    label: string,
    value: string,
    opts?: { description?: string; limit?: number },
  ): Promise<MemoryWriteResult>;
  replaceInBlock(
    scope: MemoryScope,
    label: string,
    oldText: string,
    newText: string,
    opts?: { limit?: number },
  ): Promise<MemoryWriteResult>;
  replaceManyInBlock(
    scope: MemoryScope,
    label: string,
    edits: MemoryEdit[],
    opts?: { limit?: number },
  ): Promise<MemoryWriteResult>;
};

const SEED_BLOCKS: Array<{ scope: MemoryScope; label: string }> = [
  { scope: "global", label: "persona" },
  { scope: "global", label: "human" },
  { scope: "project", label: "project" },
];

function scopeDir(projectDirectory: string, scope: MemoryScope): string {
  return scope === "global"
    ? path.join(os.homedir(), ".config", "opencode", "memory")
    : path.join(projectDirectory, ".opencode", "memory");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureGitignore(projectDirectory: string): Promise<void> {
  const memoryDir = path.join(projectDirectory, ".opencode", "memory");
  const gitignorePath = path.join(memoryDir, ".gitignore");

  await fs.mkdir(memoryDir, { recursive: true });

  if (await exists(gitignorePath)) {
    return;
  }

  await fs.writeFile(gitignorePath, "*\n", "utf-8");
}

function stableSortBlocks(blocks: MemoryBlock[]): MemoryBlock[] {
  // Stable ordering for prompt caching (if provider supported).
  // Prefer a small set of canonical blocks first.
  const priority = (block: MemoryBlock): [number, string] => {
    if (block.scope === "global" && block.label === "persona") return [0, block.label];
    if (block.scope === "global" && block.label === "human") return [1, block.label];
    if (block.scope === "project" && block.label === "project") return [2, block.label];

    const scopeBase = block.scope === "global" ? 10 : 20;
    return [scopeBase, block.label];
  };

  blocks.sort((a, b) => {
    const [pa, la] = priority(a);
    const [pb, lb] = priority(b);
    if (pa !== pb) return pa - pb;
    return la.localeCompare(lb);
  });

  return blocks;
}

export function createMemoryStore(projectDirectory: string): MemoryStore {
  return {
    async ensureSeed() {
      await ensureGitignore(projectDirectory);

      for (const seed of SEED_BLOCKS) {
        const dir = scopeDir(projectDirectory, seed.scope);
        await fs.mkdir(dir, { recursive: true });

        const filePath = path.join(dir, `${seed.label}.md`);
        if (await exists(filePath)) {
          continue;
        }

        await writeBlockFile(filePath, {
          label: seed.label,
          description: "",
          limit: 5000,
          readOnly: false,
          value: "",
        });
      }
    },

    async listBlocks(scope) {
      const scopes: MemoryScope[] = scope === "all" ? ["global", "project"] : [scope];
      const blocks: MemoryBlock[] = [];

      for (const s of scopes) {
        const dir = scopeDir(projectDirectory, s);
        if (!(await exists(dir))) {
          continue;
        }

        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (!entry.name.endsWith(".md")) continue;

          const filePath = path.join(dir, entry.name);
          try {
            blocks.push(await readBlockFile(s, filePath));
          } catch (err) {
            // Ignore invalid files silently for now, but keep going.
          }
        }
      }

      return stableSortBlocks(blocks)
    },

    async getBlock(scope, label) {
      const safeLabel = validateLabel(label);
      const dir = scopeDir(projectDirectory, scope);
      const filePath = path.join(dir, `${safeLabel}.md`);

      if (!(await exists(filePath))) {
        throw new Error(`Memory block not found: ${scope}:${safeLabel}`);
      }

      return readBlockFile(scope, filePath);
    },

    async setBlock(scope, label, value, opts) {
      const safeLabel = validateLabel(label);
      const dir = scopeDir(projectDirectory, scope);
      await fs.mkdir(dir, { recursive: true });

      const filePath = path.join(dir, `${safeLabel}.md`);
      const existing = (await exists(filePath)) ? await readBlockFile(scope, filePath) : undefined;

      if (existing?.readOnly) {
        throw new Error(`Memory block is read-only: ${scope}:${safeLabel}`);
      }

      const description = (opts?.description ?? existing?.description ?? "").trim();
      const limit = opts?.limit ?? existing?.limit ?? 5000;

      // Soft limit: a write is never rejected for size. The block may
      // temporarily exceed `limit`; render marks it OVER_LIMIT so the model
      // compacts it. Rejecting here only forced costly full-block retries.
      await writeBlockFile(filePath, {
        label: safeLabel,
        description,
        limit,
        readOnly: existing?.readOnly ?? false,
        value,
      });

      return {
        scope,
        label: safeLabel,
        chars: value.length,
        limit,
        overage: Math.max(0, value.length - limit),
      };
    },

    async replaceInBlock(scope, label, oldText, newText, opts) {
      return this.replaceManyInBlock(scope, label, [{ oldText, newText }], opts);
    },

    async replaceManyInBlock(scope, label, edits, opts) {
      const block = await this.getBlock(scope, label);
      if (block.readOnly) {
        throw new Error(`Memory block is read-only: ${scope}:${block.label}`);
      }
      if (edits.length === 0) {
        throw new Error(`No edits provided for ${scope}:${block.label}.`);
      }

      let next = block.value;
      for (const [i, edit] of edits.entries()) {
        const { oldText, newText } = edit;
        if (oldText.length === 0) {
          throw new Error(`Edit #${i + 1} has an empty oldText for ${scope}:${block.label}.`);
        }
        if (!next.includes(oldText)) {
          throw notFoundError(scope, block.label, next, oldText, i);
        }
        next = next.replace(oldText, newText);
      }

      const limit = opts?.limit ?? block.limit;

      // Soft limit: see setBlock. Growing a near-full block is allowed.
      await writeBlockFile(block.filePath, {
        label: block.label,
        description: block.description,
        limit,
        readOnly: block.readOnly,
        value: next,
      });

      return {
        scope,
        label: block.label,
        chars: next.length,
        limit,
        overage: Math.max(0, next.length - limit),
      };
    },
  };
}
