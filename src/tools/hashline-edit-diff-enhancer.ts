// Hashline Edit Diff Enhancer (spec §16 extension).
//
// Enhances the edit tool's hashline mode with:
//   1. Precise unified diff generation from before/after content.
//   2. Syntax block detection (function, class, if/else, for, while, etc.).
//   3. Contextual diff hunks with configurable surrounding lines.
//   4. Enhanced hashline patch generation with syntax-block awareness.
//
// Conventions: data + functions only, no class. Tagged unions via `_tag`.

import { computeHash } from "./edit";

// ---------------------------------------------------------------------------
// Syntax block types
// ---------------------------------------------------------------------------

export type SyntaxBlockKind =
  | "function"
  | "class"
  | "method"
  | "if"
  | "else"
  | "for"
  | "while"
  | "switch"
  | "try"
  | "catch"
  | "block";

export type SyntaxBlock = {
  kind: SyntaxBlockKind;
  name: string;
  startLine: number; // 1-indexed
  endLine: number;   // 1-indexed, inclusive
  indent: number;    // leading whitespace chars
  children: SyntaxBlock[];
};

// ---------------------------------------------------------------------------
// Diff types
// ---------------------------------------------------------------------------

export type DiffLineKind = "context" | "added" | "removed";

export type DiffLine = {
  kind: DiffLineKind;
  lineNumber: number; // line number in the relevant file (old or new)
  text: string;
};

export type DiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
  header?: string; // optional function/block context
};

export type DiffResult = {
  hunks: DiffHunk[];
  oldLineCount: number;
  newLineCount: number;
  additions: number;
  deletions: number;
  changed: boolean;
};

// ---------------------------------------------------------------------------
// Enhanced patch types
// ---------------------------------------------------------------------------

export type EnhancedPatchOp =
  | { _tag: "LINE_SWAP"; lineStart: number; lineEnd: number; content: string }
  | { _tag: "LINE_DEL"; lineStart: number; lineEnd: number }
  | { _tag: "LINE_INS"; line: number; content: string; position: "pre" | "post" }
  | { _tag: "BLOCK_SWAP"; blockName: string; blockKind: SyntaxBlockKind; content: string }
  | { _tag: "BLOCK_DEL"; blockName: string; blockKind: SyntaxBlockKind }
  | { _tag: "BLOCK_INS"; afterBlock: string; content: string };

export type EnhancedPatch = {
  filePath: string;
  hash: string;
  operations: EnhancedPatchOp[];
  diff: DiffResult; // preview of what the patch will do
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type DiffConfig = {
  contextLines: number; // surrounding context lines (default: 3)
  maxHunkSize: number;  // max lines per hunk before splitting (default: 50)
};

const DEFAULT_DIFF_CONFIG: DiffConfig = {
  contextLines: 3,
  maxHunkSize: 50,
};

// ---------------------------------------------------------------------------
// Diff generation
// ---------------------------------------------------------------------------

export function generateDiff(
  oldContent: string,
  newContent: string,
  config: Partial<DiffConfig> = {},
): DiffResult {
  const cfg = { ...DEFAULT_DIFF_CONFIG, ...config };

  // Normalize: "".split("\n") gives [""], but empty content should have 0 lines
  const oldLines = oldContent === "" ? [] : oldContent.split("\n");
  const newLines = newContent === "" ? [] : newContent.split("\n");

  // Compute LCS-based edit script using Myers-like patience approach
  const editScript = computeEditScript(oldLines, newLines);

  // Convert edit script into hunks with context
  const hunks = buildHunks(editScript, oldLines, newLines, cfg.contextLines);

  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "added") additions++;
      if (line.kind === "removed") deletions++;
    }
  }

  return {
    hunks,
    oldLineCount: oldLines.length,
    newLineCount: newLines.length,
    additions,
    deletions,
    changed: additions > 0 || deletions > 0,
  };
}

// ---------------------------------------------------------------------------
// Format diff as unified diff string
// ---------------------------------------------------------------------------

export function formatDiff(result: DiffResult, oldName = "a", newName = "b"): string {
  if (!result.changed) return "";

  const parts: string[] = [];
  parts.push(`--- ${oldName}`);
  parts.push(`+++ ${newName}`);

  for (const hunk of result.hunks) {
    const header = hunk.header ? ` ${hunk.header}` : "";
    parts.push(
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${header}`,
    );
    for (const line of hunk.lines) {
      switch (line.kind) {
        case "context":
          parts.push(` ${line.text}`);
          break;
        case "added":
          parts.push(`+${line.text}`);
          break;
        case "removed":
          parts.push(`-${line.text}`);
          break;
      }
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Syntax block detection
// ---------------------------------------------------------------------------

// Patterns for block-opening constructs. Matches lines like:
//   function foo() {
//   export default function bar(x: number) {
//   class Foo {
//   if (condition) {
//   for (let i = 0; i < n; i++) {
//   while (true) {
//   switch (x) {
//   try {
//   catch (e) {
//   } else if (cond) {
//   } else {
// Also handles arrow functions assigned to const/let/var:
//   const foo = (x) => {
//   const bar = function() {

type BlockPattern = {
  kind: SyntaxBlockKind;
  regex: RegExp;
  nameGroup?: number; // regex group index for the name
};

const BLOCK_PATTERNS: BlockPattern[] = [
  // Arrow function: const/let/var name = (...) => {
  {
    kind: "function",
    regex: /(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>\s*\{/,
    nameGroup: 1,
  },
  // Function expression: const/let/var name = function(...) {
  {
    kind: "function",
    regex: /(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\s*\*?\s*\(/,
    nameGroup: 1,
  },
  // Function declaration
  {
    kind: "function",
    regex: /(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s+(\w+)\s*\(/,
    nameGroup: 1,
  },
  // Class declaration
  {
    kind: "class",
    regex: /(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)/,
    nameGroup: 1,
  },
  // Method definition (inside class or object): name(...) { or async name(...) {
  // Excludes language keywords to avoid false matches on if/for/while/etc.
  {
    kind: "method",
    regex: /^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(?!(?:if|else|for|while|switch|try|catch|do|function|class|return|throw|new|delete|typeof|void|instanceof|in|of|yield|await)\b)(\w+)\s*\([^)]*\)\s*(?::\s*\S+\s*)?\{/,
    nameGroup: 1,
  },
  // if
  {
    kind: "if",
    regex: /(?:}\s*else\s+)?if\s*\(/,
  },
  // else
  {
    kind: "else",
    regex: /}\s*else\s*\{/,
  },
  // for
  {
    kind: "for",
    regex: /(?:for|for\s+await)\s*\(/,
  },
  // while
  {
    kind: "while",
    regex: /while\s*\(/,
  },
  // switch
  {
    kind: "switch",
    regex: /switch\s*\(/,
  },
  // try
  {
    kind: "try",
    regex: /try\s*\{/,
  },
  // catch
  {
    kind: "catch",
    regex: /catch\s*(?:\([^)]*\))?\s*\{/,
  },
];

export function detectSyntaxBlocks(content: string): SyntaxBlock[] {
  const lines = content.split("\n");
  const blocks: SyntaxBlock[] = [];
  const stack: Array<{
    block: SyntaxBlock;
    braceDepth: number;
  }> = [];

  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    const lineNum = i + 1; // 1-indexed

    // Phase 1: Process closing braces first (pop blocks from stack)
    for (const ch of trimmed) {
      if (ch === "}") {
        braceDepth--;
        while (stack.length > 0 && braceDepth <= stack[stack.length - 1].braceDepth) {
          const entry = stack.pop()!;
          entry.block.endLine = lineNum;
        }
      }
    }

    // Phase 2: Check for block openers (push to stack)
    for (const pattern of BLOCK_PATTERNS) {
      const match = trimmed.match(pattern.regex);
      if (match && trimmed.endsWith("{")) {
        const name = pattern.nameGroup ? (match[pattern.nameGroup] ?? "") : "";
        const block: SyntaxBlock = {
          kind: pattern.kind,
          name,
          startLine: lineNum,
          endLine: lineNum, // will be updated when closing brace found
          indent,
          children: [],
        };

        // Find parent: the innermost block on the stack
        if (stack.length > 0) {
          stack[stack.length - 1].block.children.push(block);
        } else {
          blocks.push(block);
        }

        stack.push({ block, braceDepth });
        break; // Only match first pattern
      }
    }

    // Phase 3: Count opening braces
    for (const ch of trimmed) {
      if (ch === "{") braceDepth++;
    }
  }

  // Close any unclosed blocks at EOF
  while (stack.length > 0) {
    const entry = stack.pop()!;
    entry.block.endLine = lines.length;
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Find a syntax block by name
// ---------------------------------------------------------------------------

export function findBlockByName(
  blocks: SyntaxBlock[],
  name: string,
  kind?: SyntaxBlockKind,
): SyntaxBlock | undefined {
  for (const block of blocks) {
    if (block.name === name && (kind === undefined || block.kind === kind)) {
      return block;
    }
    const found = findBlockByName(block.children, name, kind);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Find block at a specific line
// ---------------------------------------------------------------------------

export function findBlockAtLine(
  blocks: SyntaxBlock[],
  line: number,
): SyntaxBlock | undefined {
  let deepest: SyntaxBlock | undefined;
  for (const block of blocks) {
    if (line >= block.startLine && line <= block.endLine) {
      if (!deepest || (block.endLine - block.startLine) < (deepest.endLine - deepest.startLine)) {
        deepest = block;
      }
      const child = findBlockAtLine(block.children, line);
      if (child && (child.endLine - child.startLine) < (deepest.endLine - deepest.startLine)) {
        deepest = child;
      }
    }
  }
  return deepest;
}

// ---------------------------------------------------------------------------
// Enhanced hashline patch generation
// ---------------------------------------------------------------------------

export function generateEnhancedPatch(
  filePath: string,
  oldContent: string,
  newContent: string,
  config: Partial<DiffConfig> = {},
): EnhancedPatch {
  const hash = computeHash(oldContent);
  const diff = generateDiff(oldContent, newContent, config);
  const oldBlocks = detectSyntaxBlocks(oldContent);
  const newBlocks = detectSyntaxBlocks(newContent);

  const operations: EnhancedPatchOp[] = [];
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // Identify changed regions from diff hunks
  const changedRegions = extractChangedRegions(diff);

  // For each changed region, determine if it aligns with a syntax block
  for (const region of changedRegions) {
    const block = findEnclosingBlock(oldBlocks, region.oldStart, region.oldEnd);

    if (block && block.startLine === region.oldStart && block.endLine === region.oldEnd) {
      // Exact block match — use block-level operation
      // Check if a block with same name exists in new content
      const newBlock = findBlockByName(newBlocks, block.name, block.kind);
      if (!newBlock) {
        // Block was deleted
        operations.push({
          _tag: "BLOCK_DEL",
          blockName: block.name,
          blockKind: block.kind,
        });
      } else {
        // Block was swapped — get the new content for this block
        const newBlockContent = newLines.slice(newBlock.startLine - 1, newBlock.endLine).join("\n");
        const oldBlockContent = oldLines.slice(block.startLine - 1, block.endLine).join("\n");
        if (newBlockContent !== oldBlockContent) {
          operations.push({
            _tag: "BLOCK_SWAP",
            blockName: block.name,
            blockKind: block.kind,
            content: newBlockContent,
          });
        }
      }
    } else {
      // Line-level operation
      // Figure out what changed: pure deletion, insertion, or swap
      const oldRegionLines = oldLines.slice(region.oldStart - 1, region.oldEnd);
      const newRegionLines = newLines.slice(region.newStart - 1, region.newEnd);

      if (region.oldStart > region.oldEnd) {
        // Pure insertion
        operations.push({
          _tag: "LINE_INS",
          line: region.newStart,
          content: newRegionLines.join("\n"),
          position: "post",
        });
      } else if (region.newStart > region.newEnd) {
        // Pure deletion
        operations.push({
          _tag: "LINE_DEL",
          lineStart: region.oldStart,
          lineEnd: region.oldEnd,
        });
      } else {
        // Swap
        operations.push({
          _tag: "LINE_SWAP",
          lineStart: region.oldStart,
          lineEnd: region.oldEnd,
          content: newRegionLines.join("\n"),
        });
      }
    }
  }

  return {
    filePath,
    hash,
    operations,
    diff,
  };
}

// ---------------------------------------------------------------------------
// Convert enhanced patch to standard hashline format
// ---------------------------------------------------------------------------

export function toHashlineFormat(patch: EnhancedPatch): string {
  const parts: string[] = [];
  parts.push(`[${patch.filePath}#${patch.hash}]`);

  for (const op of patch.operations) {
    switch (op._tag) {
      case "LINE_SWAP":
        parts.push(`SWAP ${op.lineStart}-${op.lineEnd}`);
        parts.push(op.content);
        break;
      case "LINE_DEL":
        parts.push(`DEL ${op.lineStart}-${op.lineEnd}`);
        break;
      case "LINE_INS":
        parts.push(`INS.${op.position === "pre" ? "PRE" : "POST"} ${op.line}`);
        parts.push(op.content);
        break;
      case "BLOCK_SWAP": {
        // Convert block swap to SWAP.BLK using the block's line range
        // We need to look up the block; for now emit as comment + SWAP
        parts.push(`# block: ${op.blockName} (${op.blockKind})`);
        parts.push(op.content);
        break;
      }
      case "BLOCK_DEL":
        parts.push(`# block delete: ${op.blockName} (${op.blockKind})`);
        break;
      case "BLOCK_INS":
        parts.push(`# block insert after: ${op.afterBlock}`);
        parts.push(op.content);
        break;
    }
  }

  parts.push("---");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Compute diff summary (compact, for tool output)
// ---------------------------------------------------------------------------

export function formatDiffSummary(result: DiffResult): string {
  if (!result.changed) return "No changes.";

  const parts: string[] = [];
  parts.push(
    `@@ ${result.additions} addition${result.additions === 1 ? "" : "s"}, ` +
      `${result.deletions} deletion${result.deletions === 1 ? "" : "s"} ` +
      `(${result.oldLineCount} → ${result.newLineCount} lines)`,
  );

  for (const hunk of result.hunks) {
    if (hunk.header) {
      parts.push(`  in ${hunk.header}`);
    }
    const added = hunk.lines.filter((l) => l.kind === "added").length;
    const removed = hunk.lines.filter((l) => l.kind === "removed").length;
    parts.push(`  @@ -${hunk.oldStart} +${hunk.newStart} @@ (+${added}/-${removed})`);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Format a compact inline diff for a single hunk (for tool output display)
// ---------------------------------------------------------------------------

export function formatInlineDiff(result: DiffResult, maxLines = 20): string {
  if (!result.changed) return "(no changes)";

  const allLines: string[] = [];
  for (const hunk of result.hunks) {
    for (const line of hunk.lines) {
      switch (line.kind) {
        case "removed":
          allLines.push(`- ${line.text}`);
          break;
        case "added":
          allLines.push(`+ ${line.text}`);
          break;
        case "context":
          allLines.push(`  ${line.text}`);
          break;
      }
    }
  }

  if (allLines.length <= maxLines) {
    return allLines.join("\n");
  }

  // Show first N/2 and last N/2 with truncation marker
  const half = Math.floor(maxLines / 2);
  const top = allLines.slice(0, half);
  const bottom = allLines.slice(-half);
  const omitted = allLines.length - maxLines;

  return [...top, `  ... (${omitted} lines omitted) ...`, ...bottom].join("\n");
}

// ---------------------------------------------------------------------------
// INTERNAL: Edit script computation (LCS-based)
// ---------------------------------------------------------------------------

type EditOp =
  | { _tag: "equal"; oldIdx: number; newIdx: number; count: number }
  | { _tag: "replace"; oldStart: number; oldEnd: number; newStart: number; newEnd: number }
  | { _tag: "insert"; newIdx: number; count: number }
  | { _tag: "delete"; oldIdx: number; count: number };

function computeEditScript(oldLines: string[], newLines: string[]): EditOp[] {
  // LCS via dynamic programming
  const m = oldLines.length;
  const n = newLines.length;

  // Optimization: if files are identical, return immediately
  if (m === n && oldLines.every((l, i) => l === newLines[i])) {
    return m > 0 ? [{ _tag: "equal", oldIdx: 0, newIdx: 0, count: m }] : [];
  }

  // For very large files, use a simpler heuristic to avoid O(m*n) memory
  if (m * n > 10_000_000) {
    return computeEditScriptFast(oldLines, newLines);
  }

  // Standard LCS DP
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to produce edit script — single-step approach to avoid
  // greedy inner loops that consume lines which should be equal.
  const rawOps: EditOp[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      i--;
      j--;
      rawOps.push({ _tag: "equal", oldIdx: i, newIdx: j, count: 1 });
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      j--;
      rawOps.push({ _tag: "insert", newIdx: j, count: 1 });
    } else if (i > 0) {
      i--;
      rawOps.push({ _tag: "delete", oldIdx: i, count: 1 });
    } else {
      break;
    }
  }

  rawOps.reverse();

  // Coalesce consecutive ops of the same kind
  const ops: EditOp[] = [];
  for (const op of rawOps) {
    const last = ops.length > 0 ? ops[ops.length - 1] : undefined;
    if (last && last._tag === op._tag) {
      switch (op._tag) {
        case "equal":
          if (last._tag === "equal") {
            last.count++;
          }
          break;
        case "insert":
          if (last._tag === "insert") {
            last.count++;
          }
          break;
        case "delete":
          if (last._tag === "delete") {
            last.count++;
          }
          break;
      }
    } else {
      ops.push({ ...op });
    }
  }

  return ops;
}

// Fast edit script for large files — uses patience-like approach with hashing
function computeEditScriptFast(oldLines: string[], newLines: string[]): EditOp[] {
  const ops: EditOp[] = [];
  const m = oldLines.length;
  const n = newLines.length;

  // Find common prefix
  let prefixLen = 0;
  while (prefixLen < m && prefixLen < n && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix
  let suffixLen = 0;
  while (
    suffixLen < m - prefixLen &&
    suffixLen < n - prefixLen &&
    oldLines[m - 1 - suffixLen] === newLines[n - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  if (prefixLen > 0) {
    ops.push({ _tag: "equal", oldIdx: 0, newIdx: 0, count: prefixLen });
  }

  const oldMiddle = m - prefixLen - suffixLen;
  const newMiddle = n - prefixLen - suffixLen;

  if (oldMiddle > 0 && newMiddle > 0) {
    ops.push({
      _tag: "replace",
      oldStart: prefixLen,
      oldEnd: prefixLen + oldMiddle,
      newStart: prefixLen,
      newEnd: prefixLen + newMiddle,
    });
  } else if (oldMiddle > 0) {
    ops.push({ _tag: "delete", oldIdx: prefixLen, count: oldMiddle });
  } else if (newMiddle > 0) {
    ops.push({ _tag: "insert", newIdx: prefixLen, count: newMiddle });
  }

  if (suffixLen > 0) {
    ops.push({
      _tag: "equal",
      oldIdx: m - suffixLen,
      newIdx: n - suffixLen,
      count: suffixLen,
    });
  }

  return ops;
}

// ---------------------------------------------------------------------------
// INTERNAL: Build hunks from edit script
// ---------------------------------------------------------------------------

function buildHunks(
  ops: EditOp[],
  oldLines: string[],
  newLines: string[],
  contextLines: number,
): DiffHunk[] {
  // Collect all "interesting" (non-equal) line positions
  type ChangeRegion = {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
  };

  const regions: ChangeRegion[] = [];

  for (const op of ops) {
    switch (op._tag) {
      case "replace":
        regions.push({
          oldStart: op.oldStart,
          oldEnd: op.oldEnd,
          newStart: op.newStart,
          newEnd: op.newEnd,
        });
        break;
      case "delete":
        regions.push({
          oldStart: op.oldIdx,
          oldEnd: op.oldIdx + op.count,
          newStart: op.oldIdx, // maps to same position in new
          newEnd: op.oldIdx,
        });
        break;
      case "insert":
        regions.push({
          oldStart: op.newIdx,
          oldEnd: op.newIdx,
          newStart: op.newIdx,
          newEnd: op.newIdx + op.count,
        });
        break;
      // "equal" — skip
    }
  }

  if (regions.length === 0) return [];

  // Merge overlapping/nearby regions
  const merged: ChangeRegion[] = [regions[0]];
  for (let i = 1; i < regions.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = regions[i];

    // Check if regions overlap or are within context distance
    const oldGap = curr.oldStart - prev.oldEnd;
    const newGap = curr.newStart - prev.newEnd;

    // Only merge if regions actually overlap (gap < 0) or are directly adjacent
    // (gap = 0). Don't merge regions separated by unchanged lines — that would
    // collapse common lines into the change region and inflate add/del counts.
    if (oldGap <= 0 && newGap <= 0) {
      // Merge — take the max of both ends
      prev.oldEnd = Math.max(prev.oldEnd, curr.oldEnd);
      prev.newEnd = Math.max(prev.newEnd, curr.newEnd);
    } else {
      merged.push(curr);
    }
  }

  // Build hunks
  const hunks: DiffHunk[] = [];
  for (const region of merged) {
    // Expand to include context
    const hunkOldStart = Math.max(0, region.oldStart - contextLines);
    const hunkOldEnd = Math.min(oldLines.length, region.oldEnd + contextLines);

    // Context count before and after the change (same in old and new)
    const contextBefore = region.oldStart - hunkOldStart;
    const contextAfter = hunkOldEnd - region.oldEnd;
    const removedCount = region.oldEnd - region.oldStart;
    const addedCount = region.newEnd - region.newStart;

    // newStart in the file: old start position adjusted for size delta
    // delta = added - removed for all changes before this region
    // For simplicity, derive from region position
    const hunkNewStart = region.newStart - contextBefore;

    const lines: DiffLine[] = [];

    // Context before (from old lines)
    for (let i = hunkOldStart; i < region.oldStart; i++) {
      lines.push({ kind: "context", lineNumber: i + 1, text: oldLines[i] });
    }

    // Removed lines (from old)
    for (let i = region.oldStart; i < region.oldEnd; i++) {
      lines.push({ kind: "removed", lineNumber: i + 1, text: oldLines[i] });
    }

    // Added lines (from new)
    for (let i = region.newStart; i < region.newEnd; i++) {
      lines.push({ kind: "added", lineNumber: i + 1, text: newLines[i] });
    }

    // Context after (from old lines — unchanged content)
    for (let i = region.oldEnd; i < hunkOldEnd; i++) {
      lines.push({ kind: "context", lineNumber: i + 1, text: oldLines[i] });
    }

    hunks.push({
      oldStart: hunkOldStart + 1,
      oldCount: contextBefore + removedCount + contextAfter,
      newStart: hunkNewStart + 1,
      newCount: contextBefore + addedCount + contextAfter,
      lines,
    });
  }

  // Merge overlapping hunks (when context expansion causes overlap)
  const mergedHunks: DiffHunk[] = [];
  for (const hunk of hunks) {
    const last = mergedHunks.length > 0 ? mergedHunks[mergedHunks.length - 1] : undefined;
    if (last && hunk.oldStart <= last.oldStart + last.oldCount) {
      // Hunks overlap — merge them
      const combinedLines = [...last.lines];
      // Add lines from new hunk that aren't already covered
      const lastOldEnd = last.oldStart + last.oldCount - 1;
      for (const line of hunk.lines) {
        if (line.kind === "context" && line.lineNumber <= lastOldEnd) {
          continue; // already covered by previous hunk
        }
        combinedLines.push(line);
      }
      last.lines = combinedLines;
      last.oldCount = Math.max(last.oldStart + last.oldCount, hunk.oldStart + hunk.oldCount) - last.oldStart;
      last.newCount = Math.max(last.newStart + last.newCount, hunk.newStart + hunk.newCount) - last.newStart;
    } else {
      mergedHunks.push(hunk);
    }
  }

  return mergedHunks;
}

// ---------------------------------------------------------------------------
// INTERNAL: Extract changed regions from diff
// ---------------------------------------------------------------------------

type ChangedRegion = {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
};

function extractChangedRegions(diff: DiffResult): ChangedRegion[] {
  const regions: ChangedRegion[] = [];

  for (const hunk of diff.hunks) {
    let oldStart = -1;
    let oldEnd = -1;
    let newStart = -1;
    let newEnd = -1;

    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const line of hunk.lines) {
      switch (line.kind) {
        case "context":
          // Flush any pending change region
          if (oldStart !== -1) {
            regions.push({ oldStart, oldEnd, newStart, newEnd });
            oldStart = -1;
          }
          oldLine++;
          newLine++;
          break;
        case "removed":
          if (oldStart === -1) {
            oldStart = oldLine;
            newStart = newLine;
          }
          oldEnd = oldLine;
          oldLine++;
          break;
        case "added":
          if (oldStart === -1) {
            oldStart = oldLine;
            newStart = newLine;
          }
          newEnd = newLine;
          newLine++;
          break;
      }
    }

    // Flush final region
    if (oldStart !== -1) {
      regions.push({ oldStart, oldEnd, newStart, newEnd });
    }
  }

  return regions;
}

// ---------------------------------------------------------------------------
// INTERNAL: Find enclosing syntax block for a line range
// ---------------------------------------------------------------------------

function findEnclosingBlock(
  blocks: SyntaxBlock[],
  startLine: number,
  endLine: number,
): SyntaxBlock | undefined {
  for (const block of blocks) {
    if (block.startLine <= startLine && block.endLine >= endLine) {
      // Check children first for a tighter match
      const child = findEnclosingBlock(block.children, startLine, endLine);
      if (child) return child;
      return block;
    }
  }
  return undefined;
}
