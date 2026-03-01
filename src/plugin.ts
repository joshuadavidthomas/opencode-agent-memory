import type { Plugin, ToolDefinition } from "@opencode-ai/plugin";

import { createJournalStore, JOURNAL_SYSTEM_NOTE, loadConfig } from "./journal";
import { JournalRead, JournalSearch, JournalWrite } from "./journal-tools";
import type { JournalContext } from "./journal-tools";
import { createMemoryStore } from "./memory";
import { renderMemoryBlocks } from "./prompt";
import { MemoryList, MemoryReplace, MemorySet } from "./tools";

export const MemoryPlugin: Plugin = async ({ directory }) => {
  const store = createMemoryStore(directory);
  await store.ensureSeed();

  // Journal: opt-in via ~/.config/opencode/agent-memory.json
  const config = await loadConfig();
  const journalEnabled = config.journal?.enabled === true;

  // Mutable state updated by chat.message hook
  const journalCtx: JournalContext = {
    directory,
    model: "",
    provider: "",
  };

  let journalTools: Record<string, ToolDefinition> = {};

  if (journalEnabled) {
    const journalStore = createJournalStore();
    journalTools = {
      journal_write: JournalWrite(journalStore, journalCtx),
      journal_read: JournalRead(journalStore),
      journal_search: JournalSearch(journalStore),
    };
  }

  return {
    "chat.message": async (input, _output) => {
      if (input.model) {
        journalCtx.model = input.model.modelID;
        journalCtx.provider = input.model.providerID;
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const blocks = await store.listBlocks("all");
      const xml = renderMemoryBlocks(blocks);
      if (!xml) return;

      // Insert early (right after provider header) for salience.
      // OpenCode will re-join system chunks to preserve caching.
      const insertAt = output.system.length > 0 ? 1 : 0;
      output.system.splice(insertAt, 0, xml);

      // Append journal instructions at the end (preserves memory block cache)
      if (journalEnabled) {
        output.system.push(JOURNAL_SYSTEM_NOTE);
      }
    },

    tool: {
      memory_list: MemoryList(store),
      memory_set: MemorySet(store),
      memory_replace: MemoryReplace(store),
      ...journalTools,
    },
  };
};
