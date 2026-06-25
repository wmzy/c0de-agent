// Fsync skip guard (spec §5.4).
//
// Detects fsync-related calls in bash commands before execution and returns
// structured warnings with suggested alternatives. This helps agents avoid
// expensive disk-sync operations that degrade performance in development
// and CI environments.
//
// Design: pure data + functions, no class. The main API is `checkFsync()`
// which returns a `FsyncGuardResult` — plugging into any bash execution
// path (tool execute, executor pre-check, etc.).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FsyncGuardResult =
  | { ok: true }
  | {
      ok: false;
      /** The detected fsync-related term. */
      detected: string;
      /** Human-readable warning describing the issue. */
      warning: string;
      /** One or more alternative approaches to suggest. */
      alternatives: string[];
    };

// ---------------------------------------------------------------------------
// Detection patterns
//
// Each entry maps a regex (matching a bash command string) to a label and
// a set of alternative suggestions. The first match wins — we report only
// the most specific detection.
// ---------------------------------------------------------------------------

interface FsyncPattern {
  regex: RegExp;
  label: string;
  warning: (match: string) => string;
  alternatives: string[];
}

const FSYNC_PATTERNS: FsyncPattern[] = [
  {
    // Standalone `sync` command (full line or after ;/&&/||)
    regex: /(?:^|;|\|\||&&)\s*sync\s*(?:$|;|\|\||&&|#)/m,
    label: "sync",
    warning: (match) =>
      `Command contains "sync" at "${match.trim()}". Full-disk sync (` +
      "sync(1)) flushes ALL filesystem write buffers in the kernel — it is " +
      "a global, synchronous operation that blocks until every dirty page is " +
      "written to disk. This can take seconds to minutes and harms every " +
      "concurrent IO operation on the system.",
    alternatives: [
      "Use fsync(fd) via a small C/Node helper if you must sync one file — avoids global flush.",
      "Use syncfs(fd) to sync only the filesystem containing the file descriptor.",
      "Use O_SYNC / O_DSYNC open flags for targeted sync-per-write without a separate call.",
      "Skip sync entirely in dev/CI — file-system journaling already provides crash safety.",
    ],
  },
  {
    // `sync` used as a prefix followed by an argument (e.g. `sync -f`, `sync /mnt`)
    regex: /(?:^|;|\|\||&&)\s*sync\s+-\w+/m,
    label: "sync (with flags)",
    warning: () =>
      'Command calls "sync" with flags. This is still a global filesystem ' +
      "sync even when targeting a path; the kernel queues a writeback for " +
      "all dirty pages before returning.",
    alternatives: [
      "Use syncfs(fd) for per-filesystem sync.",
      "Use fsync(fd) for per-file sync.",
      "Drop sync entirely in non-production workflows — it is almost never needed.",
    ],
  },
  {
    // fsync / fdatasync system call references — may appear in build commands,
    // compile flags, or find/sed/awk patterns.
    regex: /\bf(?:dat)?sync\b/,
    label: "fsync",
    warning: () =>
      'Command references "fsync" or "fdatasync". Explicit per-file sync ' +
      "is expensive: it forces a disk cache write + flush, blocking the " +
      "calling thread until the storage device confirms persistence. In " +
      "testing, CI, or rapid-iteration dev workflows this adds hundreds of " +
      "milliseconds per call with no practical benefit.",
    alternatives: [
      "Batch writes and call fsync once at the end of the write sequence.",
      "Use fdatasync instead of fsync to skip metadata flush — ~50% cheaper.",
      "Use O_SYNC on open() to avoid explicit fsync calls entirely (one flag, same guarantee).",
      'Temporarily skip fsync in dev: set a flag like `export LIB_FSYNC=0` if the library supports it.',
    ],
  },
  {
    // Common compile/build references
    regex: /-D\w*FSYNC\w*|fsync\s*\(|fdatasync\s*\(/i,
    label: "compile-time fsync",
    warning: () =>
      "Command contains a compile/link reference to fsync or fdatasync. " +
      "If this builds a tool or driver that issues fsync calls at runtime, " +
      "consider whether the runtime usage is appropriate for a dev/CI " +
      "workload — fsync is often unnecessary and can dominate latency.",
    alternatives: [
      'Compile with -DFSYNC_SKIP or similar feature flag if available.',
      "Build a debug variant that replaces fsync with a no-op via LD_PRELOAD.",
      "Reduce fsync frequency in the consuming application rather than eliminating it at build time.",
    ],
  },
];

// ---------------------------------------------------------------------------
// checkFsync — public entry point
// ---------------------------------------------------------------------------

/**
 * Inspect a bash command string for fsync-related calls.
 *
 * Returns `{ ok: true }` when no fsync pattern is detected, or a structured
 * warning + alternatives when a match is found.
 *
 * This is a pure function with no side effects — safe to call anywhere in
 * the tool pipeline.
 */
export function checkFsync(command: string): FsyncGuardResult {
  for (const entry of FSYNC_PATTERNS) {
    const m = entry.regex.exec(command);
    if (m) {
      return {
        ok: false,
        detected: entry.label,
        warning: entry.warning(m[0] ?? m.input),
        alternatives: entry.alternatives,
      };
    }
  }
  return { ok: true };
}
