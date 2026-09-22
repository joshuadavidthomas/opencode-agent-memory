import type { MemoryBlock } from "./memory";
import { getMemoryInstructions } from "./letta";

const LINE_NUMBER_WARNING =
  "# NOTE: Line numbers shown below (with arrows like '1→') are to help during editing. Do NOT include line number prefixes in your memory edit tool calls.";

function renderMemoryMetadata(): string {
  return `<memory_metadata>
- Memory blocks are editable with memory_set and memory_replace.
- Use memory_get when you need the current on-disk value or modification time.
- Use memory tools to manage your memory blocks
</memory_metadata>`;
}

export function renderMemoryBlocks(
  blocks: MemoryBlock[],
  opts?: { disableGlobal?: boolean },
): string {
  if (blocks.length === 0) {
    return "";
  }

  const parts: string[] = [
    getMemoryInstructions(opts?.disableGlobal),
    "",
    "<memory_blocks>",
    "The following memory blocks are currently engaged in your core memory unit:",
    "",
  ];

  for (const block of blocks) {
    // escape xml
    const desc = block.description
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");

    const numberedValue = block.value
      ? block.value.split("\n").map((line, i) => `${i + 1}→ ${line}`).join("\n")
      : "";

    const overage = block.value.length - block.limit;
    const overLimitLine = overage > 0
      ? `\n- over_limit=true (over=${overage} chars)`
      : "\n- over_limit=false";
    const overLimitWarning = overage > 0
      ? "\nThis block is OVER its chars_limit. Compact it before the next session snapshot or raise its limit intentionally."
      : "";

    const memoryBlock = `<${block.label}>
<description>
${desc}
</description>
<metadata>
- chars_current=${block.value.length}
- chars_limit=${block.limit}${overLimitLine}
- read_only=${block.readOnly}
- scope=${block.scope}
</metadata>
<warning>
${LINE_NUMBER_WARNING}${overLimitWarning}
</warning>
<value>
${numberedValue}
</value>
</${block.label}>`;

    parts.push(memoryBlock);
  }

  parts.push("</memory_blocks>");
  parts.push("");
  parts.push(renderMemoryMetadata());

  return parts.join("\n");
}
