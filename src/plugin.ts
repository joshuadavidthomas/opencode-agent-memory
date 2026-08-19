import type { Plugin, ToolDefinition } from "@opencode-ai/plugin";

import {
  buildJournalSystemNote,
  createJournalStore,
  loadConfig,
} from "./journal";
import { createMemoryStore } from "./memory";
import { renderMemoryBlocks } from "./prompt";
import { SNAPSHOT_PREFIX, createSnapshotStore } from "./snapshot";
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

  const snapshots = createSnapshotStore();
  await snapshots.purge();

  return {
    "chat.message": async (input, _output) => {
      if (input.model) {
        journalCtx.model = input.model.modelID;
        journalCtx.provider = input.model.providerID;
      }
    },

    event: async ({ event }) => {
      // Compaction rewrites the whole history, so the frozen snapshot (and
      // the narrative edits that followed it) is gone. Drop it so the next
      // request renders a fresh one.
      if (event.type === "session.compacted") {
        await snapshots.invalidate(event.properties.sessionID);
      }
    },

    // Memory blocks are injected as a synthetic FIRST message of the
    // conversation (not into the system prompt) and then re-injected with
    // byte-identical content on every request. This keeps the entire system
    // prompt + message history a stable cache prefix: memory edits made
    // during the session no longer bust the provider prompt cache (they
    // remain visible to the model as natural amendments in the history).
    "experimental.chat.messages.transform": async (_input, output) => {
      const first = output.messages[0];
      if (!first) return;

      const sessionID = first.info.sessionID;
      if (!sessionID) return;

      const firstText = first.parts.find(
        (part) => part.type === "text",
      ) as { text: string } | undefined;
      if (firstText?.text?.startsWith(SNAPSHOT_PREFIX)) return; // ours already in place

      const xml = await snapshots.get(sessionID, async () =>
        renderMemoryBlocks(await store.listBlocks("all")),
      );
      if (!xml) return;

      const message = `${SNAPSHOT_PREFIX}\n${xml}`;
      output.messages.unshift({
        info: {
          id: `memory-snapshot-${sessionID}`,
          sessionID,
          role: "user",
          time: { created: first.info.time.created },
          agent:
            first.info.role === "user" ? first.info.agent : "build",
          model:
            first.info.role === "user"
              ? first.info.model
              : {
                  providerID: first.info.providerID,
                  modelID: first.info.modelID,
                },
        },
        parts: [
          {
            id: `memory-snapshot-${sessionID}`,
            sessionID,
            messageID: `memory-snapshot-${sessionID}`,
            type: "text",
            text: message,
            synthetic: true,
          },
        ],
      });
    },

    // Journal instructions stay in the system prompt: they are static text
    // describing the journal tools, so they do not harm prompt caching.
    "experimental.chat.system.transform": async (_input, output) => {
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
