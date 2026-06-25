// File revert mechanism (inspired by OpenCode revert.ts).
//
// Provides automatic rollback for file-modifying tools (write, edit) when
// execution fails. Snapshots are stored in memory (Map<path, content>) and
// restored on failure. On success, snapshots are discarded (commit).
//
// Design:
//   - data + functions, no class
//   - FileSnapshot: before/after state of a file
//   - RevertStore: per-execution snapshot batch with save/rollback/commit
//   - isRevertable(name): check if a tool needs revert protection
//   - extractFilePaths(name, input): extract paths from tool input
//   - withRevertProtection(name, input, execute): wrapper for executeTool
//
// Conventions:
//   - RevertStore is created fresh per tool execution (no shared state)
//   - Snapshot saves original content before tool modifies the file
//   - Rollback restores original content (or deletes files that didn't exist)
//   - Commit discards snapshots (operation succeeded)

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Snapshot of a file before modification. */
export type FileSnapshot = {
  path: string;
  content: string | undefined;
  existed: boolean;
};

/** Batch of snapshots for atomic rollback. */
export type SnapshotBatch = Map<string, FileSnapshot>;

/** Revert store — manages snapshots for a single tool execution. */
export type RevertStore = {
  /** Save a snapshot of the file before modification. */
  save: (filePath: string) => Promise<void>;
  /** Rollback all saved snapshots (restore original state). */
  rollback: () => Promise<void>;
  /** Commit — discard snapshots (operation succeeded). */
  commit: () => void;
};

// ---------------------------------------------------------------------------
// Revert log
// ---------------------------------------------------------------------------

/** Single entry in the revert log — records what was reverted and why. */
export type RevertLogEntry = {
  /** ISO timestamp of the revert. */
  timestamp: string;
  /** Tool call that triggered the revert (name + callId). */
  tool: string;
  callId?: string;
  /** Files that were rolled back. */
  files: string[];
  /** Whether the rollback succeeded for each file. */
  results: Array<{ path: string; success: boolean; error?: string }>;
  /** Reason for the revert. */
  reason: string;
};

// ---------------------------------------------------------------------------
// Session-level revert store
// ---------------------------------------------------------------------------

/**
 * Session-level revert store — accumulates snapshots across multiple tool
 * calls within a single agent session. Supports:
 *   - Full rollback: revert all files modified in the session (including committed)
 *   - Partial rollback: revert only specific files
 *   - Uncommitted rollback: revert only files whose tool calls failed
 *   - Revert log: audit trail of all rollback operations
 *
 * This is the data layer. Use `createSessionRevertStore()` to instantiate.
 */
export type SessionRevertStore = {
  /** Snapshot a file before a tool modifies it. Idempotent per path. */
  snapshot: (filePath: string, toolName: string, callId?: string) => Promise<void>;
  /** Commit a tool call — marks its files as successfully modified. */
  commit: (toolName: string, callId?: string) => void;
  /** Rollback all uncommitted files (files whose tool calls failed). */
  rollbackAll: (reason: string) => Promise<RevertLogEntry[]>;
  /**
   * Rollback ALL tracked files, including committed ones.
   * Used for session-level revert on agent error (max iterations, abort, etc.).
   * This undoes every file modification made during the agent session.
   */
  rollbackEverything: (reason: string) => Promise<RevertLogEntry[]>;
  /** Rollback only the specified files. */
  rollbackFiles: (filePaths: string[], reason: string) => Promise<RevertLogEntry[]>;
  /** Get all file paths currently tracked (not yet committed or rolled back). */
  trackedPaths: () => string[];
  /** Get the revert log. */
  log: () => RevertLogEntry[];
  /** Clear all snapshots and log (e.g. on session end). */
  clear: () => void;
};

// ---------------------------------------------------------------------------
// Tools that modify files and need revert protection
// ---------------------------------------------------------------------------

const REVERTABLE_TOOLS = new Set(["write", "edit"]);

/**
 * Check if a tool needs revert protection.
 * Only write and edit tools modify files.
 */
export function isRevertable(name: string): boolean {
  return REVERTABLE_TOOLS.has(name);
}

/**
 * Extract file paths from tool input.
 * Returns paths that the tool will modify.
 */
export function extractFilePaths(name: string, input: Record<string, unknown>): string[] {
  if (name === "write" || name === "edit") {
    const path = typeof input.path === "string" ? input.path : undefined;
    return path ? [path] : [];
  }
  return [];
}

// ---------------------------------------------------------------------------
// RevertStore factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh revert store for a single tool execution.
 *
 * Usage:
 *   const store = createRevertStore();
 *   await store.save(filePath);
 *   try {
 *     // execute tool...
 *     store.commit();
 *   } catch {
 *     await store.rollback();
 *   }
 */
export function createRevertStore(): RevertStore {
  const batch: SnapshotBatch = new Map();

  async function save(filePath: string): Promise<void> {
    if (batch.has(filePath)) return; // already snapshotted

    try {
      const content = await readFile(filePath, "utf-8");
      batch.set(filePath, { path: filePath, content, existed: true });
    } catch {
      // File doesn't exist yet — snapshot as "not existed"
      batch.set(filePath, { path: filePath, content: undefined, existed: false });
    }
  }

  async function rollback(): Promise<void> {
    const errors: Error[] = [];

    for (const snap of batch.values()) {
      try {
        if (snap.existed) {
          // Restore original content
          await mkdir(dirname(snap.path), { recursive: true });
          await writeFile(snap.path, snap.content!, "utf-8");
        } else {
          // File didn't exist before — delete it (best effort)
          const { unlink } = await import("node:fs/promises");
          await unlink(snap.path).catch(() => {});
        }
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
      }
    }

    batch.clear();

    if (errors.length > 0) {
      throw new Error(
        `Revert partially failed: ${errors.map((e) => e.message).join("; ")}`,
      );
    }
  }

  function commit(): void {
    batch.clear();
  }

  return { save, rollback, commit };
}

// ---------------------------------------------------------------------------
// Session-level revert store factory
// ---------------------------------------------------------------------------

/**
 * Internal: metadata for a tracked file in the session store.
 * Maps each file path to its snapshot and the tool that modified it.
 */
export type TrackedFile = {
  snapshot: FileSnapshot;
  toolName: string;
  callId?: string;
  committed: boolean;
};

/**
 * Create a session-level revert store.
 *
 * Accumulates snapshots across tool calls. Files can be committed
 * (operation succeeded) or rolled back (operation failed).
 *
 * Usage:
 *   const sessionStore = createSessionRevertStore();
 *   // Before tool executes:
 *   await sessionStore.snapshot(path, "write", callId);
 *   // After tool succeeds:
 *   sessionStore.commit("write", callId);
 *   // On agent error:
 *   await sessionStore.rollbackAll("agent error");
 */
export function createSessionRevertStore(): SessionRevertStore {
  const tracked = new Map<string, TrackedFile>();
  const revertLog: RevertLogEntry[] = [];

  async function snapshot(filePath: string, toolName: string, callId?: string): Promise<void> {
    if (tracked.has(filePath)) return; // already snapshotted

    try {
      const content = await readFile(filePath, "utf-8");
      tracked.set(filePath, {
        snapshot: { path: filePath, content, existed: true },
        toolName,
        callId,
        committed: false,
      });
    } catch {
      tracked.set(filePath, {
        snapshot: { path: filePath, content: undefined, existed: false },
        toolName,
        callId,
        committed: false,
      });
    }
  }

  function commit(toolName: string, callId?: string): void {
    for (const [path, entry] of tracked) {
      if (entry.toolName === toolName && entry.callId === callId && !entry.committed) {
        entry.committed = true;
      }
    }
  }

  async function rollbackFiles(
    filePaths: string[],
    reason: string,
  ): Promise<RevertLogEntry[]> {
    const entries: RevertLogEntry[] = [];
    // Group by tool+callId
    const byTool = new Map<string, { paths: string[]; callId?: string }>();

    for (const filePath of filePaths) {
      const entry = tracked.get(filePath);
      if (!entry || entry.committed) continue;

      const key = entry.callId ? `${entry.toolName}:${entry.callId}` : entry.toolName;
      const group = byTool.get(key);
      if (group) {
        group.paths.push(filePath);
      } else {
        byTool.set(key, { paths: [filePath], callId: entry.callId });
      }
    }

    for (const [key, group] of byTool) {
      const toolName = key.split(":")[0];
      const results: Array<{ path: string; success: boolean; error?: string }> = [];

      for (const filePath of group.paths) {
        const entry = tracked.get(filePath);
        if (!entry) continue;

        try {
          if (entry.snapshot.existed) {
            await mkdir(dirname(entry.snapshot.path), { recursive: true });
            await writeFile(entry.snapshot.path, entry.snapshot.content!, "utf-8");
          } else {
            const { unlink } = await import("node:fs/promises");
            await unlink(entry.snapshot.path).catch(() => {});
          }
          results.push({ path: filePath, success: true });
        } catch (e) {
          results.push({
            path: filePath,
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }

        tracked.delete(filePath);
      }

      const logEntry: RevertLogEntry = {
        timestamp: new Date().toISOString(),
        tool: toolName,
        callId: group.callId,
        files: group.paths,
        results,
        reason,
      };
      revertLog.push(logEntry);
      entries.push(logEntry);
    }

    return entries;
  }

  async function rollbackAll(reason: string): Promise<RevertLogEntry[]> {
    const uncommitted = [...tracked.entries()]
      .filter(([, entry]) => !entry.committed)
      .map(([path]) => path);
    return rollbackFiles(uncommitted, reason);
  }

  async function rollbackEverything(reason: string): Promise<RevertLogEntry[]> {
    // Revert ALL tracked files regardless of commit status.
    // First unmark committed so rollbackFiles will process them.
    for (const entry of tracked.values()) {
      entry.committed = false;
    }
    const allPaths = [...tracked.keys()];
    return rollbackFiles(allPaths, reason);
  }

  function trackedPaths(): string[] {
    return [...tracked.entries()]
      .filter(([, entry]) => !entry.committed)
      .map(([path]) => path);
  }

  function log(): RevertLogEntry[] {
    return [...revertLog];
  }

  function clear(): void {
    tracked.clear();
    revertLog.length = 0;
  }

  return { snapshot, commit, rollbackAll, rollbackEverything, rollbackFiles, trackedPaths, log, clear };
}

// ---------------------------------------------------------------------------
// withRevertProtection — wrapper for executeTool
// ---------------------------------------------------------------------------

/**
 * Execute a tool function with automatic revert protection.
 *
 * For revertable tools (write/edit):
 *   1. Snapshot affected files before execution
 *   2. Execute the tool
 *   3. On success: commit (discard snapshots)
 *   4. On failure: rollback (restore original state)
 *
 * For non-revertable tools: pass through directly.
 *
 * @param name - Tool name
 * @param input - Coerced tool input (Record<string, unknown>)
 * @param execute - The tool execution function
 * @param sessionStore - Optional session-level store to accumulate snapshots
 * @param callId - Optional call id for session store tracking
 * @returns The tool result
 */
export async function withRevertProtection<T>(
  name: string,
  input: Record<string, unknown>,
  execute: () => Promise<T>,
  sessionStore?: SessionRevertStore,
  callId?: string,
): Promise<T> {
  if (!isRevertable(name)) {
    return execute();
  }

  const store = createRevertStore();
  const paths = extractFilePaths(name, input);

  // Snapshot all affected files before execution
  for (const p of paths) {
    await store.save(p);
    // Also record in session store when provided
    if (sessionStore) {
      await sessionStore.snapshot(p, name, callId);
    }
  }

  try {
    const result = await execute();
    store.commit();
    if (sessionStore) {
      sessionStore.commit(name, callId);
    }
    return result;
  } catch (error) {
    await store.rollback();
    // Session store keeps the snapshot for session-level rollback
    throw error;
  }
}
