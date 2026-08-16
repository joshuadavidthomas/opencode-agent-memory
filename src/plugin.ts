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
  const config = await loadConfig();
  const disableGlobal = config.memory?.disable_global === true;

  const store = createMemoryStore(directory, { disableGlobal });
  await store.ensureSeed();

  // Journal: opt-in via ~/.config/opencode/agent-memory.json
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

      // Insert early (right after provider header) for salience.
      // OpenCode will re-join system chunks to preserve caching.
      const insertAt = output.system.length > 0 ? 1 : 0;
      output.system.splice(insertAt, 0, xml);

      // Append journal instructions at the end (preserves memory block cache)
      if (journalSystemNote) {
        output.system.push(journalSystemNote);
      }
    },

    tool: {
      memory_list: MemoryList(store, { disableGlobal }),
      memory_set: MemorySet(store, { disableGlobal }),
      memory_replace: MemoryReplace(store, { disableGlobal }),
      ...journalTools,
    },
  };
};
