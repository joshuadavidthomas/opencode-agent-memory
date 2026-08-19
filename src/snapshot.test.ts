import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { SNAPSHOT_PREFIX, createSnapshotStore } from "./snapshot";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "snapshots-test-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("SnapshotStore", () => {
  test("renders once and persists to disk", async () => {
    const store = createSnapshotStore(dir);
    let renders = 0;
    const render = async () => {
      renders++;
      return "SNAPSHOT-A";
    };

    expect(await store.get("s1", render)).toBe("SNAPSHOT-A");
    expect(await store.get("s1", render)).toBe("SNAPSHOT-A");
    expect(renders).toBe(1);

    const onDisk = await fs.readFile(path.join(dir, "s1.xml"), "utf8");
    expect(onDisk).toBe("SNAPSHOT-A");
  });

  test("survives a simulated restart (new store instance, same disk)", async () => {
    let renders = 0;
    const render = async () => {
      renders++;
      return "SNAPSHOT-B";
    };

    const first = createSnapshotStore(dir);
    await first.get("s2", render);
    expect(renders).toBe(1);

    // "Restart": fresh process memory, snapshots only on disk
    const second = createSnapshotStore(dir);
    expect(await second.get("s2", render)).toBe("SNAPSHOT-B");
    expect(renders).toBe(1); // no re-render, bytes came from disk
  });

  test("invalidate drops L1 and disk copies", async () => {
    const store = createSnapshotStore(dir);
    await store.get("s3", async () => "OLD");
    await store.invalidate("s3");

    expect(await store.get("s3", async () => "NEW")).toBe("NEW");
    expect(await fs.readFile(path.join(dir, "s3.xml"), "utf8")).toBe("NEW");
  });

  test("purge removes stale snapshots only", async () => {
    const store = createSnapshotStore(dir);
    await store.get("fresh", async () => "FRESH");

    const staleFile = path.join(dir, "stale.xml");
    await fs.writeFile(staleFile, "STALE");
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await fs.utimes(staleFile, old, old);

    await store.purge();

    expect(await fs.readFile(path.join(dir, "fresh.xml"), "utf8")).toBe(
      "FRESH",
    );
    await expect(fs.readFile(staleFile, "utf8")).rejects.toThrow();
  });

  test("snapshot prefix marker is stable and versioned", () => {
    expect(SNAPSHOT_PREFIX).toBe(
      "<!-- opencode-agent-memory:snapshot:1 -->",
    );
  });
});
