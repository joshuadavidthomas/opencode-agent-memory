import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { atomicWriteFile } from "./frontmatter";

/**
 * Marker prefix of the synthetic snapshot message. Parsed (never rendered)
 * by the plugin on every request to recognise its own injection among the
 * conversation messages. Bump the version number when the snapshot layout
 * changes in a way the detector must distinguish.
 */
export const SNAPSHOT_PREFIX = "<!-- opencode-agent-memory:snapshot:1 -->";

/**
 * Snapshots older than this are purged on startup.
 */
const PURGE_AFTER_DAYS = 30;

export interface SnapshotStore {
  /**
   * Return the frozen snapshot for a session. Resolution order:
   * in-memory L1 cache → on-disk cold copy → freshly rendered via `render`
   * (and persisted to disk). Once created, the exact same bytes are served
   * for the lifetime of the session, so the injected message is byte-stable
   * across requests and the provider prompt cache survives.
   */
  get(sessionID: string, render: () => Promise<string>): Promise<string>;
  /**
   * Drop the snapshot (L1 + disk). Used after session compaction, where the
   * history is rewritten and a fresh snapshot is desirable.
   */
  invalidate(sessionID: string): Promise<void>;
  /**
   * Delete on-disk snapshots not read within PURGE_AFTER_DAYS. Best effort.
   */
  purge(): Promise<void>;
}

export function defaultSnapshotsDir(): string {
  return path.join(
    os.homedir(),
    ".local",
    "share",
    "opencode",
    "agent-memory",
    "snapshots",
  );
}

export function createSnapshotStore(
  snapshotsDir: string = defaultSnapshotsDir(),
): SnapshotStore {
  const l1 = new Map<string, string>();
  const lastRead = new Map<string, number>();

  const fileOf = (sessionID: string) =>
    path.join(snapshotsDir, `${sessionID}.xml`);

  async function readFromDisk(sessionID: string): Promise<string | undefined> {
    try {
      return await fs.readFile(fileOf(sessionID), "utf8");
    } catch {
      return undefined;
    }
  }

  return {
    async get(sessionID, render) {
      const cached = l1.get(sessionID);
      if (cached !== undefined) {
        lastRead.set(sessionID, Date.now());
        return cached;
      }

      const cold = await readFromDisk(sessionID);
      if (cold !== undefined) {
        l1.set(sessionID, cold);
        lastRead.set(sessionID, Date.now());
        return cold;
      }

      const fresh = await render();
      l1.set(sessionID, fresh);
      lastRead.set(sessionID, Date.now());
      await fs.mkdir(snapshotsDir, { recursive: true });
      await atomicWriteFile(fileOf(sessionID), fresh);
      return fresh;
    },

    async invalidate(sessionID) {
      l1.delete(sessionID);
      lastRead.delete(sessionID);
      await fs.rm(fileOf(sessionID), { force: true });
    },

    async purge() {
      try {
        const entries = await fs.readdir(snapshotsDir);
        const cutoff = Date.now() - PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000;
        await Promise.all(
          entries.map(async (entry) => {
            const file = path.join(snapshotsDir, entry);
            const stat = await fs.stat(file).catch(() => undefined);
            if (stat && stat.mtimeMs < cutoff) {
              await fs.rm(file, { force: true });
            }
          }),
        );
      } catch {
        // snapshots dir may not exist yet; nothing to purge
      }
    },
  };
}
