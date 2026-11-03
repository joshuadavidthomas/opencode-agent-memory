import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as yaml from "js-yaml";

export function splitFrontmatter(text: string): {
  frontmatterText: string | undefined;
  body: string;
} {
  if (!text.startsWith("---\n")) {
    return { frontmatterText: undefined, body: text };
  }

  const endIndex = text.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return { frontmatterText: undefined, body: text };
  }

  const frontmatterText = text.slice(4, endIndex);
  const body = text.slice(endIndex + "\n---\n".length);
  return { frontmatterText, body };
}

export function buildFrontmatterDocument(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const frontmatterYaml = yaml.dump(frontmatter, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: true,
  });

  return `---\n${frontmatterYaml}---\n${body.trim()}\n`;
}

export async function atomicWriteFile(
  filePath: string,
  content: string,
): Promise<void> {
  // A per-write temp name: two concurrent writers to the same block must not
  // share one temp path. With a fixed name the first `rename` consumes the temp
  // file and every other writer fails with ENOENT, so a concurrent
  // `memory_set`/`memory_replace` silently loses its update.
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );

  try {
    await fs.writeFile(tempPath, content, "utf-8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
