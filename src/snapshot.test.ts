import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createSnapshotStore } from "./snapshot";

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-snapshots-"));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("snapshot store", () => {
  test("renders once and survives a new store instance", async () => {
    let renders = 0;
    const render = async () => `snapshot-${++renders}`;
    const first = createSnapshotStore(directory);

    expect(await first.get("session-1", "", render)).toBe("snapshot-1");
    expect(await first.get("session-1", "", render)).toBe("snapshot-1");
    expect(await createSnapshotStore(directory).get("session-1", "", render)).toBe("snapshot-1");
    expect(renders).toBe(1);
  });

  test("regenerates when the project, configuration, or compaction changes", async () => {
    const first = createSnapshotStore(directory, "project-a:global");
    await first.get("session-scope", "compaction-1", async () => "global snapshot");

    const isolated = createSnapshotStore(directory, "project-a:project-only");
    expect(
      await isolated.get("session-scope", "compaction-1", async () => "project snapshot"),
    ).toBe("project snapshot");

    const compacted = createSnapshotStore(directory, "project-a:project-only");
    expect(
      await compacted.get("session-scope", "compaction-2", async () => "fresh snapshot"),
    ).toBe("fresh snapshot");

    const otherProject = createSnapshotStore(directory, "project-b:project-only");
    expect(
      await otherProject.get("session-scope", "compaction-2", async () => "other project"),
    ).toBe("other project");
  });

  test("coalesces concurrent first reads", async () => {
    let renders = 0;
    const store = createSnapshotStore(directory);
    const values = await Promise.all([
      store.get("session-2", "", async () => `snapshot-${++renders}`),
      store.get("session-2", "", async () => `snapshot-${++renders}`),
    ]);

    expect(values).toEqual(["snapshot-1", "snapshot-1"]);
    expect(renders).toBe(1);
  });

  test("coalesces concurrent reads after the generation changes", async () => {
    const store = createSnapshotStore(directory);
    await store.get("session-generation-race", "old", async () => "old snapshot");
    let renders = 0;

    const values = await Promise.all([
      store.get("session-generation-race", "new", async () => {
        renders++;
        await Bun.sleep(1);
        return "new snapshot";
      }),
      store.get("session-generation-race", "new", async () => {
        renders++;
        await Bun.sleep(1);
        return "new snapshot";
      }),
    ]);

    expect(values).toEqual(["new snapshot", "new snapshot"]);
    expect(renders).toBe(1);
    expect(
      await createSnapshotStore(directory).get(
        "session-generation-race",
        "new",
        async () => "unexpected render",
      ),
    ).toBe("new snapshot");
  });

  test("invalidate refreshes the in-memory and on-disk snapshot", async () => {
    const store = createSnapshotStore(directory);
    await store.get("session-3", "", async () => "old");
    await store.invalidate("session-3");
    expect(await store.get("session-3", "", async () => "new")).toBe("new");
  });

  test("invalidate waits for an in-flight render and blocks stale reads", async () => {
    const store = createSnapshotStore(directory);
    let finishRender: ((value: string) => void) | undefined;
    let markRenderStarted: (() => void) | undefined;
    const renderStarted = new Promise<void>((resolve) => {
      markRenderStarted = resolve;
    });
    const rendering = store.get(
      "session-race",
      "",
      () => new Promise<string>((resolve) => {
        finishRender = resolve;
        markRenderStarted?.();
      }),
    );
    await renderStarted;

    const invalidating = store.invalidate("session-race");
    let replacementRendered = false;
    const replacement = store.get("session-race", "", async () => {
      replacementRendered = true;
      return "after compaction";
    });

    expect(replacementRendered).toBe(false);
    if (!finishRender) throw new Error("render did not start");
    finishRender("before compaction");

    expect(await rendering).toBe("before compaction");
    await invalidating;
    expect(await replacement).toBe("after compaction");
    expect(
      await createSnapshotStore(directory).get(
        "session-race",
        "",
        async () => "unexpected render",
      ),
    ).toBe("after compaction");
  });

  test("purge removes stale snapshots", async () => {
    const store = createSnapshotStore(directory);
    await store.get("fresh", "", async () => "fresh");
    const stale = path.join(directory, "stale.xml");
    await fs.writeFile(stale, "stale");
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await fs.utimes(stale, old, old);

    await store.purge();

    await expect(fs.access(stale)).rejects.toThrow();
    expect(await store.get("fresh", "", async () => "wrong")).toBe("fresh");
  });
});
