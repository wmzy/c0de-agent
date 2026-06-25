// Tests for the revert mechanism (revert.ts)
//
// Covers:
//   - createRevertStore: snapshot, rollback, commit lifecycle
//   - isRevertable: tool name check
//   - extractFilePaths: path extraction from tool input
//   - withRevertProtection: full integration with rollback on failure
//   - createSessionRevertStore: session-level accumulation and rollback
//   - RevertLogEntry: audit trail of rollback operations
//   - rollbackEverything: full session revert (including committed files)
//   - rollbackFiles: partial revert of specific files

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createRevertStore,
  createSessionRevertStore,
  isRevertable,
  extractFilePaths,
  withRevertProtection,
} from "./revert";
import type { SessionRevertStore } from "./revert";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

function randomName(): string {
  return `revert-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeEach(async () => {
  testDir = join(tmpdir(), randomName());
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  // Clean up test directory
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(testDir);
    for (const f of files) {
      await unlink(join(testDir, f)).catch(() => {});
    }
    await rmdir(testDir).catch(() => {});
  } catch {
    // Best effort cleanup
  }
});

// ---------------------------------------------------------------------------
// isRevertable
// ---------------------------------------------------------------------------

describe("isRevertable", () => {
  it("returns true for write", () => {
    expect(isRevertable("write")).toBe(true);
  });

  it("returns true for edit", () => {
    expect(isRevertable("edit")).toBe(true);
  });

  it("returns false for read", () => {
    expect(isRevertable("read")).toBe(false);
  });

  it("returns false for bash", () => {
    expect(isRevertable("bash")).toBe(false);
  });

  it("returns false for unknown tools", () => {
    expect(isRevertable("unknown_tool")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractFilePaths
// ---------------------------------------------------------------------------

describe("extractFilePaths", () => {
  it("extracts path from write input", () => {
    const paths = extractFilePaths("write", { path: "/tmp/test.txt", content: "hello" });
    expect(paths).toEqual(["/tmp/test.txt"]);
  });

  it("extracts path from edit input", () => {
    const paths = extractFilePaths("edit", { path: "/tmp/test.ts", search: "a", replace: "b" });
    expect(paths).toEqual(["/tmp/test.ts"]);
  });

  it("returns empty for non-revertable tools", () => {
    const paths = extractFilePaths("bash", { command: "echo hi" });
    expect(paths).toEqual([]);
  });

  it("returns empty when path is missing", () => {
    const paths = extractFilePaths("write", { content: "hello" });
    expect(paths).toEqual([]);
  });

  it("returns empty when path is not a string", () => {
    const paths = extractFilePaths("write", { path: 123 });
    expect(paths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createRevertStore — snapshot + rollback
// ---------------------------------------------------------------------------

describe("createRevertStore", () => {
  it("rolls back an existing file to its original content", async () => {
    const filePath = join(testDir, "existing.txt");
    await writeFile(filePath, "original content", "utf-8");

    const store = createRevertStore();
    await store.save(filePath);

    // Modify the file
    await writeFile(filePath, "modified content", "utf-8");

    // Rollback
    await store.rollback();

    const restored = await readFile(filePath, "utf-8");
    expect(restored).toBe("original content");
  });

  it("deletes a file that was created during the operation", async () => {
    const filePath = join(testDir, "new-file.txt");
    // File doesn't exist yet

    const store = createRevertStore();
    await store.save(filePath); // snapshot: file doesn't exist

    // Create the file
    await writeFile(filePath, "new content", "utf-8");

    // Rollback
    await store.rollback();

    // File should be deleted
    await expect(readFile(filePath, "utf-8")).rejects.toThrow();
  });

  it("commits (discards snapshots) without restoring", async () => {
    const filePath = join(testDir, "commit-test.txt");
    await writeFile(filePath, "original", "utf-8");

    const store = createRevertStore();
    await store.save(filePath);

    await writeFile(filePath, "modified", "utf-8");

    store.commit();

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("modified"); // not restored
  });

  it("handles multiple files atomically", async () => {
    const file1 = join(testDir, "file1.txt");
    const file2 = join(testDir, "file2.txt");
    const file3 = join(testDir, "file3.txt");

    await writeFile(file1, "content1", "utf-8");
    await writeFile(file2, "content2", "utf-8");
    // file3 doesn't exist yet

    const store = createRevertStore();
    await store.save(file1);
    await store.save(file2);
    await store.save(file3);

    // Modify all files
    await writeFile(file1, "modified1", "utf-8");
    await writeFile(file2, "modified2", "utf-8");
    await writeFile(file3, "new3", "utf-8");

    // Rollback all
    await store.rollback();

    expect(await readFile(file1, "utf-8")).toBe("content1");
    expect(await readFile(file2, "utf-8")).toBe("content2");
    await expect(readFile(file3, "utf-8")).rejects.toThrow();
  });

  it("is idempotent for the same path", async () => {
    const filePath = join(testDir, "idempotent.txt");
    await writeFile(filePath, "original", "utf-8");

    const store = createRevertStore();
    await store.save(filePath);
    await store.save(filePath); // duplicate — should be no-op

    await writeFile(filePath, "modified", "utf-8");
    await store.rollback();

    expect(await readFile(filePath, "utf-8")).toBe("original");
  });
});

// ---------------------------------------------------------------------------
// withRevertProtection
// ---------------------------------------------------------------------------

describe("withRevertProtection", () => {
  it("rolls back on thrown error", async () => {
    const filePath = join(testDir, "throw-test.txt");
    await writeFile(filePath, "before", "utf-8");

    await expect(
      withRevertProtection(
        "write",
        { path: filePath, content: "after" },
        async () => {
          await writeFile(filePath, "after", "utf-8");
          throw new Error("tool failed");
        },
      ),
    ).rejects.toThrow("tool failed");

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("before");
  });

  it("commits on success (no rollback)", async () => {
    const filePath = join(testDir, "success-test.txt");
    await writeFile(filePath, "before", "utf-8");

    await withRevertProtection(
      "write",
      { path: filePath, content: "after" },
      async () => {
        await writeFile(filePath, "after", "utf-8");
        return { _tag: "success", output: "done" };
      },
    );

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("after");
  });

  it("passes through for non-revertable tools", async () => {
    let called = false;
    await withRevertProtection("bash", { command: "echo hi" }, async () => {
      called = true;
      return { _tag: "success", output: "hi" };
    });
    expect(called).toBe(true);
  });

  it("handles new file creation + rollback", async () => {
    const filePath = join(testDir, "new-create.txt");
    // File doesn't exist

    await expect(readFile(filePath, "utf-8")).rejects.toThrow();

    await expect(
      withRevertProtection(
        "write",
        { path: filePath, content: "created" },
        async () => {
          await writeFile(filePath, "created", "utf-8");
          throw new Error("simulated failure");
        },
      ),
    ).rejects.toThrow("simulated failure");

    // File should be cleaned up
    await expect(readFile(filePath, "utf-8")).rejects.toThrow();
  });

  it("propagates the error after rollback", async () => {
    const filePath = join(testDir, "propagate.txt");
    await writeFile(filePath, "original", "utf-8");

    await expect(
      withRevertProtection(
        "edit",
        { path: filePath, search: "x", replace: "y" },
        async () => {
          await writeFile(filePath, "modified", "utf-8");
          throw new TypeError("specific error");
        },
      ),
    ).rejects.toThrow("specific error");

    // File should be restored
    expect(await readFile(filePath, "utf-8")).toBe("original");
  });

  it("records snapshots in session store when provided", async () => {
    const filePath = join(testDir, "session-track.txt");
    await writeFile(filePath, "original", "utf-8");

    const sessionStore = createSessionRevertStore();

    await withRevertProtection(
      "write",
      { path: filePath, content: "modified" },
      async () => {
        await writeFile(filePath, "modified", "utf-8");
        return { _tag: "success", output: "done" };
      },
      sessionStore,
      "call-1",
    );

    // Session store should have committed the file
    expect(sessionStore.trackedPaths()).toEqual([]);
    // But log should be empty since no rollback happened
    expect(sessionStore.log()).toEqual([]);
  });

  it("keeps uncommitted snapshots for session-level rollback", async () => {
    const filePath = join(testDir, "session-rollback.txt");
    await writeFile(filePath, "original", "utf-8");

    const sessionStore = createSessionRevertStore();

    await expect(
      withRevertProtection(
        "write",
        { path: filePath, content: "modified" },
        async () => {
          await writeFile(filePath, "modified", "utf-8");
          throw new Error("tool failed");
        },
        sessionStore,
        "call-1",
      ),
    ).rejects.toThrow("tool failed");

    // Executor already rolled back, but session store still tracks the file
    // (uncommitted) for potential session-level rollback
    expect(await readFile(filePath, "utf-8")).toBe("original");
  });
});

// ---------------------------------------------------------------------------
// createSessionRevertStore
// ---------------------------------------------------------------------------

describe("createSessionRevertStore", () => {
  it("tracks multiple files across tool calls", async () => {
    const file1 = join(testDir, "sess-1.txt");
    const file2 = join(testDir, "sess-2.txt");
    await writeFile(file1, "orig1", "utf-8");
    await writeFile(file2, "orig2", "utf-8");

    const store = createSessionRevertStore();
    await store.snapshot(file1, "write", "call-1");
    await store.snapshot(file2, "write", "call-2");

    // Modify both files
    await writeFile(file1, "mod1", "utf-8");
    await writeFile(file2, "mod2", "utf-8");

    // Rollback all uncommitted
    await store.rollbackAll("test");

    expect(await readFile(file1, "utf-8")).toBe("orig1");
    expect(await readFile(file2, "utf-8")).toBe("orig2");
  });

  it("skips committed files on rollbackAll", async () => {
    const file1 = join(testDir, "committed.txt");
    const file2 = join(testDir, "uncommitted.txt");
    await writeFile(file1, "orig1", "utf-8");
    await writeFile(file2, "orig2", "utf-8");

    const store = createSessionRevertStore();
    await store.snapshot(file1, "write", "call-1");
    await store.snapshot(file2, "write", "call-2");

    // Commit call-1, leave call-2 uncommitted
    store.commit("write", "call-1");

    // Modify both files
    await writeFile(file1, "mod1", "utf-8");
    await writeFile(file2, "mod2", "utf-8");

    // RollbackAll only reverts uncommitted
    await store.rollbackAll("test");

    // file1 was committed — stays modified
    expect(await readFile(file1, "utf-8")).toBe("mod1");
    // file2 was uncommitted — reverted
    expect(await readFile(file2, "utf-8")).toBe("orig2");
  });

  it("rollbackEverything reverts committed files too", async () => {
    const file1 = join(testDir, "committed2.txt");
    const file2 = join(testDir, "uncommitted2.txt");
    await writeFile(file1, "orig1", "utf-8");
    await writeFile(file2, "orig2", "utf-8");

    const store = createSessionRevertStore();
    await store.snapshot(file1, "write", "call-1");
    await store.snapshot(file2, "write", "call-2");

    store.commit("write", "call-1");

    await writeFile(file1, "mod1", "utf-8");
    await writeFile(file2, "mod2", "utf-8");

    // rollbackEverything reverts ALL files
    await store.rollbackEverything("agent error");

    expect(await readFile(file1, "utf-8")).toBe("orig1");
    expect(await readFile(file2, "utf-8")).toBe("orig2");
  });

  it("rollbackFiles reverts only specified files", async () => {
    const file1 = join(testDir, "partial-1.txt");
    const file2 = join(testDir, "partial-2.txt");
    const file3 = join(testDir, "partial-3.txt");
    await writeFile(file1, "orig1", "utf-8");
    await writeFile(file2, "orig2", "utf-8");
    await writeFile(file3, "orig3", "utf-8");

    const store = createSessionRevertStore();
    await store.snapshot(file1, "write", "call-1");
    await store.snapshot(file2, "write", "call-2");
    await store.snapshot(file3, "write", "call-3");

    await writeFile(file1, "mod1", "utf-8");
    await writeFile(file2, "mod2", "utf-8");
    await writeFile(file3, "mod3", "utf-8");

    // Only revert file1 and file3
    await store.rollbackFiles([file1, file3], "partial rollback");

    expect(await readFile(file1, "utf-8")).toBe("orig1");
    expect(await readFile(file2, "utf-8")).toBe("mod2"); // not reverted
    expect(await readFile(file3, "utf-8")).toBe("orig3");
  });

  it("creates revert log entries on rollback", async () => {
    const file1 = join(testDir, "log-1.txt");
    const file2 = join(testDir, "log-2.txt");
    await writeFile(file1, "orig1", "utf-8");
    // file2 doesn't exist

    const store = createSessionRevertStore();
    await store.snapshot(file1, "write", "call-1");
    await store.snapshot(file2, "write", "call-2");

    await writeFile(file1, "mod1", "utf-8");
    await writeFile(file2, "new", "utf-8");

    await store.rollbackAll("log test");

    const log = store.log();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].reason).toBe("log test");
    expect(log[0].tool).toBe("write");
    expect(log[0].timestamp).toBeTruthy();
    expect(log[0].results.every((r) => r.success)).toBe(true);
  });

  it("returns empty log when no rollbacks occurred", () => {
    const store = createSessionRevertStore();
    expect(store.log()).toEqual([]);
  });

  it("trackedPaths returns only uncommitted paths", async () => {
    const file1 = join(testDir, "track-1.txt");
    const file2 = join(testDir, "track-2.txt");
    await writeFile(file1, "orig1", "utf-8");
    await writeFile(file2, "orig2", "utf-8");

    const store = createSessionRevertStore();
    await store.snapshot(file1, "write", "call-1");
    await store.snapshot(file2, "write", "call-2");

    store.commit("write", "call-1");

    const tracked = store.trackedPaths();
    expect(tracked).toEqual([file2]);
  });

  it("clear removes all snapshots and log", async () => {
    const file1 = join(testDir, "clear-1.txt");
    await writeFile(file1, "orig", "utf-8");

    const store = createSessionRevertStore();
    await store.snapshot(file1, "write", "call-1");
    await store.rollbackAll("test");

    expect(store.log().length).toBeGreaterThan(0);
    expect(store.trackedPaths().length).toBe(0); // already rolled back

    store.clear();
    expect(store.log()).toEqual([]);
  });

  it("handles new file creation in session store", async () => {
    const filePath = join(testDir, "session-new.txt");
    // File doesn't exist

    const store = createSessionRevertStore();
    await store.snapshot(filePath, "write", "call-1");

    // Create the file
    await writeFile(filePath, "new content", "utf-8");

    // Rollback
    await store.rollbackAll("test");

    // File should be deleted
    await expect(readFile(filePath, "utf-8")).rejects.toThrow();
  });

  it("is idempotent for the same path", async () => {
    const filePath = join(testDir, "idempotent-session.txt");
    await writeFile(filePath, "original", "utf-8");

    const store = createSessionRevertStore();
    await store.snapshot(filePath, "write", "call-1");
    await store.snapshot(filePath, "write", "call-1"); // duplicate

    await writeFile(filePath, "modified", "utf-8");
    await store.rollbackAll("test");

    expect(await readFile(filePath, "utf-8")).toBe("original");
  });

  it("tracks files from different tools separately", async () => {
    const file1 = join(testDir, "multi-tool-1.txt");
    const file2 = join(testDir, "multi-tool-2.txt");
    await writeFile(file1, "orig1", "utf-8");
    await writeFile(file2, "orig2", "utf-8");

    const store = createSessionRevertStore();
    await store.snapshot(file1, "write", "call-1");
    await store.snapshot(file2, "edit", "call-2");

    // Commit only the write tool call
    store.commit("write", "call-1");

    await writeFile(file1, "mod1", "utf-8");
    await writeFile(file2, "mod2", "utf-8");

    await store.rollbackAll("test");

    // file1 was committed (write tool) — stays modified
    expect(await readFile(file1, "utf-8")).toBe("mod1");
    // file2 was uncommitted (edit tool) — reverted
    expect(await readFile(file2, "utf-8")).toBe("orig2");
  });
});
