import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";

import { atomicWriteFile } from "./frontmatter";

const PURGE_AFTER_DAYS = 30;

export type SnapshotStore = {
  get(
    sessionID: string,
    generation: string,
    render: () => Promise<string>,
  ): Promise<string>;
  invalidate(sessionID: string): Promise<void>;
  purge(): Promise<void>;
};

type SnapshotFile = {
  version: 1;
  scope: string;
  generation: string;
  xml: string;
};

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
  scope = "",
): SnapshotStore {
  const scopeID = createHash("sha256").update(scope).digest("hex");
  const snapshots = new Map<
    string,
    { generation: string; value: Promise<string> }
  >();
  const invalidations = new Map<string, Promise<void>>();
  const fileOf = (sessionID: string) =>
    path.join(snapshotsDir, `${encodeURIComponent(sessionID)}.xml`);

  async function invalidate(sessionID: string): Promise<void> {
    const previous = invalidations.get(sessionID) ?? Promise.resolve();
    const invalidation = previous.then(async () => {
      const snapshot = snapshots.get(sessionID);
      snapshots.delete(sessionID);
      await snapshot?.value.catch(() => undefined);
      snapshots.delete(sessionID);
      await fs.rm(fileOf(sessionID), { force: true });
    });

    invalidations.set(sessionID, invalidation);
    try {
      await invalidation;
    } finally {
      if (invalidations.get(sessionID) === invalidation) {
        invalidations.delete(sessionID);
      }
    }
  }

  async function get(
    sessionID: string,
    generation: string,
    render: () => Promise<string>,
  ): Promise<string> {
    const invalidation = invalidations.get(sessionID);
    if (invalidation) await invalidation;

    const cached = snapshots.get(sessionID);
    if (cached?.generation === generation) return cached.value;
    if (cached) {
      await invalidate(sessionID);
      return get(sessionID, generation, render);
    }

    const value = (async () => {
      try {
        const persisted = JSON.parse(
          await fs.readFile(fileOf(sessionID), "utf8"),
        ) as Partial<SnapshotFile>;
        if (
          persisted &&
          typeof persisted === "object" &&
          persisted.version === 1 &&
          persisted.scope === scopeID &&
          persisted.generation === generation &&
          typeof persisted.xml === "string"
        ) {
          return persisted.xml;
        }
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          !(error instanceof SyntaxError)
        ) {
          throw error;
        }
      }

      const xml = await render();
      const snapshot: SnapshotFile = {
        version: 1,
        scope: scopeID,
        generation,
        xml,
      };
      await fs.mkdir(snapshotsDir, { recursive: true });
      await atomicWriteFile(fileOf(sessionID), JSON.stringify(snapshot));
      return xml;
    })();
    snapshots.set(sessionID, { generation, value });
    value.catch(() => {
      if (snapshots.get(sessionID)?.value === value) {
        snapshots.delete(sessionID);
      }
    });
    return value;
  }

  return {
    get,
    invalidate,

    async purge() {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(snapshotsDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }

      const cutoff = Date.now() - PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000;
      await Promise.all(entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".xml")) return;
        const file = path.join(snapshotsDir, entry.name);
        const stat = await fs.stat(file).catch(() => undefined);
        if (stat && stat.mtimeMs < cutoff) await fs.rm(file, { force: true });
      }));
    },
  };
}
