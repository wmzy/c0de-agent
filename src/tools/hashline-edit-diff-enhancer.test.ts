// Tests for the hashline edit diff enhancer (hashline-edit-diff-enhancer.ts)
//
// Covers:
//   - generateDiff: unified diff generation from before/after content
//   - formatDiff: unified diff string formatting
//   - formatDiffSummary / formatInlineDiff: compact diff display
//   - detectSyntaxBlocks: code block detection (function, class, if, etc.)
//   - findBlockByName / findBlockAtLine: block lookup
//   - generateEnhancedPatch: enhanced patch with syntax block awareness
//   - toHashlineFormat: conversion to standard hashline format
//   - Edge cases: empty files, identical files, large files

import { describe, expect, it } from "vitest";
import {
  generateDiff,
  formatDiff,
  formatDiffSummary,
  formatInlineDiff,
  detectSyntaxBlocks,
  findBlockByName,
  findBlockAtLine,
  generateEnhancedPatch,
  toHashlineFormat,
} from "./hashline-edit-diff-enhancer";
import { computeHash } from "./edit";

// ---------------------------------------------------------------------------
// generateDiff
// ---------------------------------------------------------------------------

describe("generateDiff", () => {
  it("returns no changes for identical content", () => {
    const content = "line1\nline2\nline3";
    const result = generateDiff(content, content);
    expect(result.changed).toBe(false);
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
    expect(result.hunks).toHaveLength(0);
  });

  it("detects a single line addition", () => {
    const old = "line1\nline2\nline3";
    const newC = "line1\nline2\nline2.5\nline3";
    const result = generateDiff(old, newC);
    expect(result.changed).toBe(true);
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(0);
    expect(result.oldLineCount).toBe(3);
    expect(result.newLineCount).toBe(4);
  });

  it("detects a single line deletion", () => {
    const old = "line1\nline2\nline3";
    const newC = "line1\nline3";
    const result = generateDiff(old, newC);
    expect(result.changed).toBe(true);
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(1);
  });

  it("detects a line replacement", () => {
    const old = "line1\nline2\nline3";
    const newC = "line1\nLINE2\nline3";
    const result = generateDiff(old, newC);
    expect(result.changed).toBe(true);
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
  });

  it("detects multiple changes in separate hunks", () => {
    const old = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
    const newLines = old.split("\n");
    newLines[2] = "CHANGED3";
    newLines[16] = "CHANGED17";
    const newC = newLines.join("\n");
    const result = generateDiff(old, newC);
    expect(result.changed).toBe(true);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(2);
  });

  it("handles empty old content (all additions)", () => {
    const result = generateDiff("", "new content\nhere");
    expect(result.changed).toBe(true);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(0);
  });

  it("handles empty new content (all deletions)", () => {
    const result = generateDiff("old content\nhere", "");
    expect(result.changed).toBe(true);
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(2);
  });

  it("handles both empty", () => {
    const result = generateDiff("", "");
    expect(result.changed).toBe(false);
  });

  it("respects contextLines config", () => {
    const old = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
    const newLines = old.split("\n");
    newLines[9] = "CHANGED";
    const newC = newLines.join("\n");
    const result = generateDiff(old, newC, { contextLines: 1 });
    expect(result.hunks.length).toBeGreaterThan(0);
    // Each hunk should have at most 1 context line before/after the change
    for (const hunk of result.hunks) {
      const contextBefore = hunk.lines.findIndex((l) => l.kind !== "context");
      const contextAfter = hunk.lines.slice().reverse().findIndex((l) => l.kind !== "context");
      if (contextBefore > 0) expect(contextBefore).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// formatDiff
// ---------------------------------------------------------------------------

describe("formatDiff", () => {
  it("returns empty string for no changes", () => {
    const result = generateDiff("same", "same");
    expect(formatDiff(result)).toBe("");
  });

  it("produces valid unified diff format", () => {
    const result = generateDiff("line1\nline2", "line1\nLINE2\nline3");
    const formatted = formatDiff(result, "old.ts", "new.ts");
    expect(formatted).toContain("--- old.ts");
    expect(formatted).toContain("+++ new.ts");
    expect(formatted).toContain("@@");
    expect(formatted).toContain("-line2");
    expect(formatted).toContain("+LINE2");
    expect(formatted).toContain("+line3");
  });

  it("includes context lines", () => {
    const old = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    const newLines = old.split("\n");
    newLines[4] = "CHANGED";
    const result = generateDiff(old, newLines.join("\n"));
    const formatted = formatDiff(result);
    // Should have context lines (prefixed with space)
    expect(formatted).toContain(" line4"); // context before
    expect(formatted).toContain(" line6"); // context after
  });
});

// ---------------------------------------------------------------------------
// formatDiffSummary
// ---------------------------------------------------------------------------

describe("formatDiffSummary", () => {
  it("reports no changes for identical content", () => {
    const result = generateDiff("same", "same");
    expect(formatDiffSummary(result)).toBe("No changes.");
  });

  it("reports addition/deletion counts", () => {
    const result = generateDiff("a\nb\nc", "a\nx\nc\nd");
    const summary = formatDiffSummary(result);
    // a->common, b->x (1 del + 1 add), c->common, d (1 add)
    expect(summary).toContain("2 additions");
    expect(summary).toContain("1 deletion");
  });

  it("reports line count change", () => {
    const result = generateDiff("a\nb", "a\nb\nc");
    const summary = formatDiffSummary(result);
    expect(summary).toContain("2 → 3 lines");
  });
});

// ---------------------------------------------------------------------------
// formatInlineDiff
// ---------------------------------------------------------------------------

describe("formatInlineDiff", () => {
  it("returns no changes message for identical content", () => {
    const result = generateDiff("same", "same");
    expect(formatInlineDiff(result)).toBe("(no changes)");
  });

  it("shows +/- prefixes for changes", () => {
    const result = generateDiff("old", "new");
    const inline = formatInlineDiff(result);
    expect(inline).toContain("- old");
    expect(inline).toContain("+ new");
  });

  it("truncates when exceeding maxLines", () => {
    const old = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n");
    const newC = Array.from({ length: 50 }, (_, i) => `LINE${i + 1}`).join("\n");
    const result = generateDiff(old, newC);
    const inline = formatInlineDiff(result, 10);
    expect(inline).toContain("lines omitted");
  });
});

// ---------------------------------------------------------------------------
// detectSyntaxBlocks
// ---------------------------------------------------------------------------

describe("detectSyntaxBlocks", () => {
  it("detects function declarations", () => {
    const code = `function hello() {
  console.log("hi");
}

function world() {
  return 42;
}`;
    const blocks = detectSyntaxBlocks(code);
    const funcs = blocks.filter((b) => b.kind === "function");
    expect(funcs).toHaveLength(2);
    expect(funcs[0].name).toBe("hello");
    expect(funcs[0].startLine).toBe(1);
    expect(funcs[0].endLine).toBe(3);
    expect(funcs[1].name).toBe("world");
    expect(funcs[1].startLine).toBe(5);
    expect(funcs[1].endLine).toBe(7);
  });

  it("detects class declarations", () => {
    const code = `class Foo {
  bar() {
    return 1;
  }
}`;
    const blocks = detectSyntaxBlocks(code);
    const classes = blocks.filter((b) => b.kind === "class");
    expect(classes).toHaveLength(1);
    expect(classes[0].name).toBe("Foo");
    expect(classes[0].startLine).toBe(1);
    expect(classes[0].endLine).toBe(5);
    // Should have a child method
    expect(classes[0].children).toHaveLength(1);
    expect(classes[0].children[0].name).toBe("bar");
    expect(classes[0].children[0].kind).toBe("method");
  });

  it("detects arrow functions assigned to const", () => {
    const code = `const greet = (name: string) => {
  return "hello " + name;
};`;
    const blocks = detectSyntaxBlocks(code);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe("greet");
    expect(blocks[0].kind).toBe("function");
  });

  it("detects if/else blocks", () => {
    const code = `if (x > 0) {
  doSomething();
} else {
  doOther();
}`;
    const blocks = detectSyntaxBlocks(code);
    const ifs = blocks.filter((b) => b.kind === "if" || b.kind === "else");
    expect(ifs.length).toBeGreaterThanOrEqual(1);
  });

  it("detects for loops", () => {
    const code = `for (let i = 0; i < 10; i++) {
  arr.push(i);
}`;
    const blocks = detectSyntaxBlocks(code);
    expect(blocks.some((b) => b.kind === "for")).toBe(true);
  });

  it("detects while loops", () => {
    const code = `while (running) {
  process();
}`;
    const blocks = detectSyntaxBlocks(code);
    expect(blocks.some((b) => b.kind === "while")).toBe(true);
  });

  it("detects try/catch", () => {
    const code = `try {
  riskyOp();
} catch (e) {
  handle(e);
}`;
    const blocks = detectSyntaxBlocks(code);
    expect(blocks.some((b) => b.kind === "try")).toBe(true);
    expect(blocks.some((b) => b.kind === "catch")).toBe(true);
  });

  it("returns empty for code with no blocks", () => {
    const code = `const x = 1;
const y = 2;
console.log(x + y);`;
    const blocks = detectSyntaxBlocks(code);
    expect(blocks).toHaveLength(0);
  });

  it("detects exported functions", () => {
    const code = `export function helper() {
  return true;
}

export default function main() {
  helper();
}`;
    const blocks = detectSyntaxBlocks(code);
    const funcs = blocks.filter((b) => b.kind === "function");
    expect(funcs).toHaveLength(2);
    expect(funcs[0].name).toBe("helper");
    expect(funcs[1].name).toBe("main");
  });

  it("detects async functions", () => {
    const code = `async function fetchData() {
  const res = await fetch(url);
  return res.json();
}`;
    const blocks = detectSyntaxBlocks(code);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe("fetchData");
    expect(blocks[0].kind).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// findBlockByName
// ---------------------------------------------------------------------------

describe("findBlockByName", () => {
  it("finds a block by name", () => {
    const code = `function alpha() {
  return 1;
}
function beta() {
  return 2;
}`;
    const blocks = detectSyntaxBlocks(code);
    const found = findBlockByName(blocks, "beta");
    expect(found).toBeDefined();
    expect(found!.name).toBe("beta");
    expect(found!.startLine).toBe(4);
  });

  it("returns undefined for missing block", () => {
    const code = `function alpha() {}`;
    const blocks = detectSyntaxBlocks(code);
    expect(findBlockByName(blocks, "missing")).toBeUndefined();
  });

  it("finds nested blocks", () => {
    const code = `class Foo {
  bar() {
    return 1;
  }
}`;
    const blocks = detectSyntaxBlocks(code);
    const bar = findBlockByName(blocks, "bar", "method");
    expect(bar).toBeDefined();
    expect(bar!.kind).toBe("method");
  });
});

// ---------------------------------------------------------------------------
// findBlockAtLine
// ---------------------------------------------------------------------------

describe("findBlockAtLine", () => {
  it("finds the innermost block containing a line", () => {
    const code = `class Foo {
  bar() {
    const x = 1;
  }
}`;
    const blocks = detectSyntaxBlocks(code);
    // Line 3 is inside bar() which is inside Foo
    const block = findBlockAtLine(blocks, 3);
    expect(block).toBeDefined();
    expect(block!.name).toBe("bar");
    expect(block!.kind).toBe("method");
  });

  it("returns undefined for line outside any block", () => {
    const code = `const x = 1;

function foo() {
  return 2;
}`;
    const blocks = detectSyntaxBlocks(code);
    expect(findBlockAtLine(blocks, 1)).toBeUndefined();
    expect(findBlockAtLine(blocks, 2)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generateEnhancedPatch
// ---------------------------------------------------------------------------

describe("generateEnhancedPatch", () => {
  it("generates patch with correct hash", () => {
    const old = "line1\nline2\nline3";
    const newC = "line1\nLINE2\nline3";
    const patch = generateEnhancedPatch("test.ts", old, newC);
    expect(patch.hash).toBe(computeHash(old));
    expect(patch.filePath).toBe("test.ts");
  });

  it("generates diff in the patch", () => {
    const old = "line1\nline2\nline3";
    const newC = "line1\nLINE2\nline3";
    const patch = generateEnhancedPatch("test.ts", old, newC);
    expect(patch.diff.changed).toBe(true);
    expect(patch.diff.additions).toBe(1);
    expect(patch.diff.deletions).toBe(1);
  });

  it("generates operations for changes", () => {
    const old = "line1\nline2\nline3";
    const newC = "line1\nLINE2\nline3";
    const patch = generateEnhancedPatch("test.ts", old, newC);
    expect(patch.operations.length).toBeGreaterThan(0);
  });

  it("handles identical content", () => {
    const content = "same content";
    const patch = generateEnhancedPatch("test.ts", content, content);
    expect(patch.diff.changed).toBe(false);
    expect(patch.operations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// toHashlineFormat
// ---------------------------------------------------------------------------

describe("toHashlineFormat", () => {
  it("produces valid hashline format", () => {
    const old = "line1\nline2\nline3";
    const newC = "line1\nLINE2\nline3";
    const patch = generateEnhancedPatch("test.ts", old, newC);
    const formatted = toHashlineFormat(patch);
    expect(formatted).toContain(`[test.ts#${computeHash(old)}]`);
    expect(formatted).toContain("---");
  });

  it("includes SWAP operations", () => {
    const old = "line1\nline2\nline3";
    const newC = "line1\nLINE2\nline3";
    const patch = generateEnhancedPatch("test.ts", old, newC);
    const formatted = toHashlineFormat(patch);
    // Should have a SWAP or similar operation
    expect(formatted).toMatch(/SWAP|DEL|INS/);
  });
});

// ---------------------------------------------------------------------------
// Integration: generateDiff + formatDiff round-trip
// ---------------------------------------------------------------------------

describe("integration: diff generation and formatting", () => {
  it("produces parseable unified diff", () => {
    const old = `function greet(name: string) {
  console.log("Hello, " + name);
  return true;
}`;
    const newC = `function greet(name: string, greeting: string) {
  console.log(greeting + ", " + name);
  return true;
}`;
    const diff = generateDiff(old, newC);
    const formatted = formatDiff(diff, "greet.ts", "greet.ts");

    // Verify structure
    const lines = formatted.split("\n");
    expect(lines[0]).toBe("--- greet.ts");
    expect(lines[1]).toBe("+++ greet.ts");
    expect(lines[2]).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/);

    // Should show the changed lines
    expect(formatted).toContain('-function greet(name: string) {');
    expect(formatted).toContain('+function greet(name: string, greeting: string) {');
  });

  it("detects multiple hunks for distant changes", () => {
    const old = Array.from({ length: 50 }, (_, i) => `// line ${i + 1}`).join("\n");
    const newLines = old.split("\n");
    newLines[4] = "// CHANGED line 5";
    newLines[44] = "// CHANGED line 45";
    const newC = newLines.join("\n");
    const diff = generateDiff(old, newC);
    expect(diff.hunks.length).toBeGreaterThanOrEqual(2);
  });
});
