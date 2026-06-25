// Notepad write guard.
//
// Detects writes targeting notepad-related file paths and returns structured
// warnings with suggested alternatives. This helps agents avoid accidentally
// overwriting or corrupting notepad-managed content via the raw `write` tool.
//
// Notepad files in Oh-My-OpenAgent are special: they are maintained by the
// notepad mechanism (e.g. sisyphus-junior-notepad) and should be manipulated
// through the notepad tool rather than via direct file writes. The guard
// inspects file paths before a write executes and warns if the path looks
// like a notepad-managed file.
//
// Design: pure data + functions, no class. The main API is `checkNotepadWrite()`
// which returns a `NotepadWriteGuardResult` — plugging into any write execution
// path (tool execute, executor pre-check, etc.).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotepadWriteGuardResult =
  | { ok: true }
  | {
      ok: false;
      /** The detected notepad-related path component. */
      detected: string;
      /** Human-readable warning describing the issue. */
      warning: string;
      /** One or more alternative approaches to suggest. */
      alternatives: string[];
    };

// ---------------------------------------------------------------------------
// Detection patterns
//
// Each entry maps a regex (matching a file path string) to a label and
// a set of alternative suggestions. The first match wins — we report only
// the most specific detection.
// ---------------------------------------------------------------------------

interface NotepadPattern {
  regex: RegExp;
  label: string;
  warning: (match: string) => string;
  alternatives: string[];
}

const NOTEPAD_PATTERNS: NotepadPattern[] = [
  {
    // Direct hit: path contains "notepad" as a filename component at end of path
    // (possibly with extension). Boundaries include path separators, hyphens,
    // underscores, dots, or start of string. Does NOT match when "notepad" is
    // followed by a path separator (that's the directory pattern).
    // e.g. notepad.md, my-notepad.json, team_notepad.md
    regex: /(?:^|[\/\\_.-])(notepad)(?:\.[a-zA-Z0-9]+)*$/i,
    label: "notepad file",
    warning: (match) =>
      `Path "${match}" targets a notepad-managed file. Notepad files are ` +
      "maintained by the agent's notepad mechanism; writing to them directly " +
      "via the `write` tool bypasses notepad's content management, versioning, " +
      "and compaction logic. This can lead to data inconsistency or loss of " +
      "notepad-tracked state across session boundaries.",
    alternatives: [
      "Use the notepad tool (e.g. `notepad write`) to update notepad-managed content — it handles serialization, indexing, and compaction correctly.",
      "Read the notepad file first with the `read` tool, then use a notepad-specific append/update command if available.",
      "If you intend to write a non-notepad file with a similar name, rename it to avoid the `notepad` keyword in the path.",
    ],
  },
  {
    // Directory path: writing inside a notepad-managed directory.
    // Matches "notepad" at start of path or after a separator, followed by
    // a path separator — e.g. notepad/data.json, .c0de/notepad/session.json
    regex: /(?:^|[\/\\])notepad[\/\\]/i,
    label: "notepad directory",
    warning: (match) =>
      `Path "${match}" writes into a notepad-managed directory. Files under ` +
      "a notepad directory are managed by the notepad lifecycle — they may be " +
      "compacted, rotated, or indexed automatically. Direct `write` tool " +
      "access bypasses these safeguards and can interfere with notepad state.",
    alternatives: [
      "Use the notepad tool (e.g. `notepad write`, `notepad append`) to create or update files under the notepad directory.",
      "Export notepad content to a separate location if you need to modify it with the `write` tool, then re-import via the notepad tool.",
      "Use `read` to inspect notepad content without risk — only writes trigger this guard.",
    ],
  },
  {
    // Generic "notes" directory — common pattern used alongside notepad.
    // Matches "note" or "notes" preceded by a boundary and followed by a
    // path separator. Boundaries include start, path separators, hyphens,
    // underscores, and dots.
    // e.g. notes/todo.md, project-notes/meeting-notes.md
    regex: /(?:^|[\/\\_.-])(notes?)[\/\\]/i,
    label: "notes directory",
    warning: (match) =>
      `Path "${match}" targets a notes/notes directory. While not guaranteed to ` +
      "be notepad-managed, such directories often participate in the notepad " +
      "system or serve similar append-only/curated content roles. Direct writes " +
      "may bypass intended content management.",
    alternatives: [
      "Verify whether this directory is managed by a notepad plugin before writing directly.",
      "Use the notepad tool if this directory is part of the notepad system.",
      "If this is an ordinary notes directory not managed by notepad, ignore this warning and proceed.",
    ],
  },
  {
    // Common notepad file extensions or conventions at end of path.
    // e.g. scratch.notepad, ideas.note, guide.note.md
    regex: /\.(?:notepad|note)(?:\.[a-zA-Z0-9]+)?$/i,
    label: "notepad extension",
    warning: (match) =>
      `Path "${match}" uses a notepad-associated file extension. Files with ` +
      "`.notepad` or `.note` extensions are typically managed by the notepad " +
      "system and should not be written to directly.",
    alternatives: [
      "Use the notepad tool to create or update files with notepad-associated extensions.",
      "Use a different file extension if this is not a notepad file (e.g. `.md`, `.txt`).",
      "Read the file first with the `read` tool to verify its role before writing.",
    ],
  },
];

// ---------------------------------------------------------------------------
// checkNotepadWrite — public entry point
// ---------------------------------------------------------------------------

/**
 * Inspect a file path string for notepad-related patterns.
 *
 * Returns `{ ok: true }` when no notepad concern is detected, or a structured
 * warning with alternatives when a notepad pattern matches.
 *
 * @param path  — the file path that would be written to (as provided to `write`)
 * @returns a `NotepadWriteGuardResult`
 */
export function checkNotepadWrite(path: string): NotepadWriteGuardResult {
  for (const pattern of NOTEPAD_PATTERNS) {
    const m = pattern.regex.exec(path);
    if (m) {
      return {
        ok: false,
        detected: pattern.label,
        warning: pattern.warning(m[0]),
        alternatives: pattern.alternatives,
      };
    }
  }
  return { ok: true };
}