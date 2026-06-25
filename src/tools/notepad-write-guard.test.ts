// Tests for notepad write guard.

import { describe, expect, it } from "vitest";
import { checkNotepadWrite } from "./notepad-write-guard";

describe("checkNotepadWrite", () => {
  // -------------------------------------------------------------------------
  // Pass-through cases
  // -------------------------------------------------------------------------

  it("returns ok for a normal file path", () => {
    const result = checkNotepadWrite("src/main.ts");
    expect(result).toEqual({ ok: true });
  });

  it("returns ok for a deeply nested source file", () => {
    const result = checkNotepadWrite("packages/core/src/utils/helpers.ts");
    expect(result).toEqual({ ok: true });
  });

  it("returns ok for paths containing 'note' as a substring inside another word", () => {
    // "noteworthy" contains "note" but is not a notes directory
    const result = checkNotepadWrite("docs/noteworthy-concepts.md");
    expect(result).toEqual({ ok: true });
  });

  it("returns ok for paths with 'notes' inside a longer word", () => {
    const result = checkNotepadWrite("src/vendor/annotation.ts");
    expect(result).toEqual({ ok: true });
  });

  it("returns ok for empty string", () => {
    const result = checkNotepadWrite("");
    expect(result).toEqual({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Notepad file name patterns
  // -------------------------------------------------------------------------

  it("detects notepad.md at root", () => {
    const result = checkNotepadWrite("notepad.md");
    assertGuardResult(result);
    expect(result.detected).toBe("notepad file");
    expect(result.alternatives.length).toBeGreaterThan(0);
  });

  it("detects notepad.txt in a subdirectory", () => {
    const result = checkNotepadWrite("docs/notepad.txt");
    assertGuardResult(result);
    expect(result.detected).toBe("notepad file");
  });

  it("does not match .notepadrc (not a standard notepad file pattern)", () => {
    // .notepadrc is a dotfile config, not a notepad-managed content file.
    const result = checkNotepadWrite(".notepadrc");
    expect(result).toEqual({ ok: true });
  });

  it("detects my-notepad.json", () => {
    const result = checkNotepadWrite("my-notepad.json");
    assertGuardResult(result);
    expect(result.detected).toBe("notepad file");
  });

  it("detects Notepad.md (case insensitive)", () => {
    const result = checkNotepadWrite("src/Notepad.md");
    assertGuardResult(result);
    expect(result.detected).toBe("notepad file");
  });

  it("detects team_notepad.md (underscore)", () => {
    const result = checkNotepadWrite("team_notepad.md");
    assertGuardResult(result);
    expect(result.detected).toBe("notepad file");
  });

  it("detects my-Notepad.json (case insensitive)", () => {
    const result = checkNotepadWrite("my-Notepad.json");
    assertGuardResult(result);
    expect(result.detected).toBe("notepad file");
  });

  // -------------------------------------------------------------------------
  // Notepad directory patterns
  // -------------------------------------------------------------------------

  it("detects a path under .c0de/notepad/", () => {
    const result = checkNotepadWrite(".c0de/notepad/session-123.json");
    assertGuardResult(result);
    expect(result.detected).toBe("notepad directory");
  });

  it("detects a path under notepad/ with deep nesting", () => {
    const result = checkNotepadWrite("notepad/agents/team/scratchpad.json");
    assertGuardResult(result);
    expect(result.detected).toBe("notepad directory");
  });

  it("detects a path starting with notepad/ at root", () => {
    const result = checkNotepadWrite("notepad/todo.md");
    assertGuardResult(result);
    expect(result.detected).toBe("notepad directory");
  });

  it("detects Windows-style backslash paths under notepad\\", () => {
    const result = checkNotepadWrite(".c0de\\notepad\\session.json");
    assertGuardResult(result);
    expect(result.detected).toBe("notepad directory");
  });

  // -------------------------------------------------------------------------
  // Notes directory patterns
  // -------------------------------------------------------------------------

  it("detects a path under notes/", () => {
    const result = checkNotepadWrite("notes/todo.md");
    assertGuardResult(result);
    expect(result.detected).toBe("notes directory");
  });

  it("detects a path under note/", () => {
    const result = checkNotepadWrite("note/journal.md");
    assertGuardResult(result);
    expect(result.detected).toBe("notes directory");
  });

  it("detects a path under project-notes/", () => {
    const result = checkNotepadWrite("project-notes/meeting-notes.md");
    assertGuardResult(result);
    expect(result.detected).toBe("notes directory");
  });

  it("detects a path under .notes/ (dot prefix)", () => {
    const result = checkNotepadWrite(".notes/config.json");
    assertGuardResult(result);
    expect(result.detected).toBe("notes directory");
  });

  it("does not match 'annotation' as a notes directory", () => {
    const result = checkNotepadWrite("src/vendor/annotation.ts");
    expect(result).toEqual({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Notepad extension patterns
  // -------------------------------------------------------------------------

  it("detects .notepad extension (matched as notepad file)", () => {
    // `scratch.notepad` matches pattern 1 (notepad file) first because
    // the path ends with "notepad" after a dot boundary.
    const result = checkNotepadWrite("scratch.notepad");
    assertGuardResult(result);
    expect(result.detected).toBe("notepad file");
  });

  it("detects .note extension", () => {
    const result = checkNotepadWrite("ideas.note");
    assertGuardResult(result);
    expect(result.detected).toBe("notepad extension");
  });

  it("detects .note.md compound extension", () => {
    const result = checkNotepadWrite("guide.note.md");
    assertGuardResult(result);
    expect(result.detected).toBe("notepad extension");
  });

  // -------------------------------------------------------------------------
  // Edge cases — first-match-wins priority
  // -------------------------------------------------------------------------

  it("prefers 'notepad file' over 'notepad directory' when target is a notepad file", () => {
    // notepad/notepad.md — the file at end wins (first pattern matches end-anchored)
    const result = checkNotepadWrite("notepad/notepad.md");
    assertGuardResult(result);
    expect(result.detected).toBe("notepad file");
  });

  it("detects 'notepad directory' when target is inside a notepad dir (no notepad filename)", () => {
    const result = checkNotepadWrite("notepad/scratch.md");
    assertGuardResult(result);
    expect(result.detected).toBe("notepad directory");
  });

  it("warns on notepad path with warning containing actionable text", () => {
    const result = checkNotepadWrite("notepad.md");
    assertGuardResult(result);
    expect(result.warning.length).toBeGreaterThan(50);
    expect(result.warning).toContain("`write` tool");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertGuardResult(
  r: unknown,
): asserts r is {
  ok: false;
  detected: string;
  warning: string;
  alternatives: string[];
} {
  expect(r).toBeDefined();
  expect((r as { ok: boolean }).ok).toBe(false);
  expect(typeof (r as { detected: unknown }).detected).toBe("string");
  expect(typeof (r as { warning: unknown }).warning).toBe("string");
  expect((r as { warning: string }).warning.length).toBeGreaterThan(50);
  expect(Array.isArray((r as { alternatives: unknown[] }).alternatives)).toBe(true);
  expect((r as { alternatives: unknown[] }).alternatives.length).toBeGreaterThan(0);
}
