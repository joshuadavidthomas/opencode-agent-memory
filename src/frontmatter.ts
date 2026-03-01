import * as fs from "node:fs/promises";
import * as path from "node:path";

import yaml from "js-yaml";

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
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp`,
  );
  await fs.writeFile(tempPath, content, "utf-8");
  await fs.rename(tempPath, filePath);
}
