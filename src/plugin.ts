import type { Plugin, ToolDefinition } from "@opencode-ai/plugin";

import {
  buildJournalSystemNote,
  createJournalStore,
  loadConfig,
} from "./journal";
import { createMemoryStore } from "./memory";
import { renderMemoryBlocks } from "./prompt";
import {
  JournalRead,
  JournalSearch,
  JournalWrite,
  MemoryList,
  MemoryReplace,
  MemorySet,
} from "./tools";
import type { JournalContext } from "./tools";

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
  let journalSystemNote = "";

  if (journalEnabled) {
    const journalStore = createJournalStore();
    journalTools = {
      journal_write: JournalWrite(journalStore, journalCtx),
      journal_read: JournalRead(journalStore),
      journal_search: JournalSearch(journalStore),
    };
    journalSystemNote = buildJournalSystemNote(config.journal?.tags);
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

      // Cache-friendly: append at the END of the system prompt. Inserting at
      // position 1 placed volatile content before ~99% of the context, which
      // busted the provider prompt-cache prefix whenever memory changed.
      output.system.push(xml);

      if (journalSystemNote) {
        output.system.push(journalSystemNote);
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
