import { Plugin } from "@opencode/plugin";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";

import { generateEmbedding } from "./embeddings";
import {
  buildJournalSystemNote,
  createJournalStore,
  loadConfig,
} from "./journal";
import { createMemoryStore } from "./memory";
import { renderMemoryBlocks } from "./prompt";
import { createSnapshotStore } from "./snapshot";
import {
  JournalRead,
  JournalSearch,
  JournalWrite,
  MemoryGet,
  MemoryList,
  MemoryOversized,
  MemoryReplace,
  MemorySet,
} from "./tools";
import type { JournalContext } from "./tools";

const MemoryPlugin = Plugin.define({
  id: "opencode-agent-memory",
  async setup(ctx) {
    const directory = ctx.location.directory;
    const config = await loadConfig(undefined, (message) => {
      console.warn(`[opencode-agent-memory] ${message}`);
    });
    const memoryEnabled = config.memory?.enabled !== false;
    const disableGlobal = config.memory?.disable_global === true;

    const store = memoryEnabled
      ? createMemoryStore(directory, { disableGlobal })
      : undefined;
    const snapshots = store
      ? createSnapshotStore(undefined, JSON.stringify({ directory, disableGlobal }))
      : undefined;
    if (store) {
      await store.ensureSeed();
      await snapshots!.purge().catch((error) => {
        console.warn("[opencode-agent-memory] Could not purge stale memory snapshots", error);
      });
    }

    // Journal: opt-in via ~/.config/opencode/agent-memory.json
    const journalEnabled = config.journal?.enabled === true;

    // Keep request metadata isolated when multiple sessions run concurrently.
    const journalModels = new Map<string, { model: string; provider: string }>();
    const journalCtx: JournalContext = {
      directory,
      getModel: (sessionID) => journalModels.get(sessionID),
    };
    let eventsAbort: AbortController | undefined;
    let eventsTask: Promise<void> | undefined;

    const tools: ToolInfo[] = store
      ? [
          MemoryList(store, { disableGlobal }),
          MemoryGet(store, { disableGlobal }),
          MemorySet(store, { disableGlobal }),
          MemoryReplace(store, { disableGlobal }),
          MemoryOversized(store, { disableGlobal }),
        ]
      : [];
    let journalSystemNote = "";

    if (journalEnabled) {
      void generateEmbedding("warmup").catch(() => {});
      const journalStore = createJournalStore();
      tools.push(
        JournalWrite(journalStore, journalCtx),
        JournalRead(journalStore),
        JournalSearch(journalStore),
      );
      journalSystemNote = buildJournalSystemNote(config.journal?.tags);
    }

    if (journalEnabled || snapshots) {
      eventsAbort = new AbortController();
      const abort = eventsAbort;
      eventsTask = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
            if (event.type === "session.deleted") {
              const sessionID = String(event.data.sessionID);
              journalModels.delete(sessionID);
              await snapshots?.invalidate(sessionID);
            }
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            console.warn("[opencode-agent-memory] Event subscription failed", error);
          }
        }
      })();
    }

    await ctx.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool);
    });

    await ctx.session.hook("context", async (event) => {
      if (journalEnabled) {
        journalModels.set(String(event.sessionID), {
          model: event.model.id,
          provider: event.model.providerID,
        });
      }

      if (store && snapshots) {
        const history = await ctx.session.context({ sessionID: event.sessionID });
        let generation = "";
        for (let index = history.length - 1; index >= 0; index--) {
          const message = history[index];
          if (message?.type === "compaction" && message.status === "completed") {
            generation = message.id;
            break;
          }
        }
        const xml = await snapshots.get(String(event.sessionID), generation, async () =>
          renderMemoryBlocks(await store.listBlocks("all"), { disableGlobal }),
        );
        if (xml) {
          // OpenCode v2 joins these parts into one provider system message.
          const insertAt = event.system.length > 0 ? 1 : 0;
          event.system.splice(insertAt, 0, { type: "text", text: xml });
        }
      }

      if (journalSystemNote) {
        event.system.push({ type: "text", text: journalSystemNote });
      }
    });

    if (eventsAbort && eventsTask) {
      return async () => {
        eventsAbort.abort();
        await eventsTask;
        journalModels.clear();
      };
    }
  },
});

export default MemoryPlugin;
