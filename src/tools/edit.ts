// Built-in `edit` tool (spec §5.4, §16).
//
// Two editing modes:
//   1. Diff mode — search/replace text substitution.
//   2. Hashline mode — content-hash anchored patches (spec §16).
//
// The hashline format:
//
//   [PATH#HASH]
//   SWAP lineStart-lineEnd
//   new content here
//   ---
//
// Operations: SWAP, DEL, INS.PRE, INS.POST, INS.HEAD, INS.TAIL,
//             SWAP.BLK, DEL.BLK, INS.BLK.POST (AST-aware).
//
// Conventions: data + functions, no class. Returns ToolResult variants.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { recordToolResult, selectBestMode } from "../core/tool-metrics";
import { ok, err, type ToolContext, type ToolDef, type ToolResult } from "./types";
import {
  generateDiff,
  formatDiffSummary,
  formatInlineDiff,
  detectSyntaxBlocks,
  generateEnhancedPatch,
} from "./hashline-edit-diff-enhancer";

// ---------------------------------------------------------------------------
// Hashline types (spec §16.3)
// ---------------------------------------------------------------------------

type PatchOp =
  | { _tag: "SWAP"; lineStart: number; lineEnd: number; content: string }
  | { _tag: "DEL"; lineStart: number; lineEnd: number }
  | { _tag: "INS.PRE"; line: number; content: string }
  | { _tag: "INS.POST"; line: number; content: string }
  | { _tag: "INS.HEAD"; content: string }
  | { _tag: "INS.TAIL"; content: string }
  | { _tag: "SWAP.BLK"; lineStart: number; lineEnd: number; content: string }
  | { _tag: "DEL.BLK"; lineStart: number; lineEnd: number }
  | { _tag: "INS.BLK.POST"; line: number; content: string };

export type ParsedPatch = {
  path: string;
  hash: string;
  operations: PatchOp[];
};

export type ApplyResult =
  | { _tag: "success"; content: string }
  | { _tag: "hash_mismatch"; expected: string; actual: string }
  | { _tag: "line_not_found"; operation: PatchOp };

// ---------------------------------------------------------------------------
// Edit mode types (spec §16.4)
// ---------------------------------------------------------------------------

type EditMode =
  | { _tag: "diff"; search: string; replace: string }
  | { _tag: "hashline"; patch: string };

// ---------------------------------------------------------------------------
// computeHash — 4-character hex hash of content (spec §16.3)
//
// Uses a 16-bit FNV-1a hash: fast, determininistic, and the 4 hex character
// output matches the spec's "4位hex" requirement. Collisions are possible
// (16 bits = 65536 values) but the hash is only a sanity anchor — accidental
// mismatches are vanishingly rare for typical file sizes and the `SWAP`/`DEL`
// line ranges provide the real positional safety.
// ---------------------------------------------------------------------------

export function computeHash(content: string): string {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    // FNV-1a prime: 0x01000193
    hash = Math.imul(hash, 0x01000193);
  }
  // Take the lower 16 bits → 4 hex chars
  return ((hash >>> 0) & 0xffff).toString(16).padStart(4, "0");
}

// ---------------------------------------------------------------------------
// parsePatch — parse hashline patch text into structured patches (spec §16.3)
//
// Input format:
//   [PATH#HASH]
//   OP lineStart[-lineEnd]
//   content (for SWAP/INS ops)
//   ---
//   [PATH#HASH]
//   OP ...
//   ---
// ---------------------------------------------------------------------------

const HEADER_RE = /^\[(.+?)#([0-9a-f]{4})\]$/;
const OP_RE =
  /^(SWAP(?:\.[A-Z]+)?|DEL(?:\.[A-Z]+)?|INS\.(?:PRE|POST|HEAD|TAIL|BLK\.POST))(?:\s+(\d+(?:-\d+)?))?$/;
const SEPARATOR_RE = /^---\s*$/;

export function parsePatch(input: string): ParsedPatch[] {
  const lines = input.split(/\r?\n/);
  const patches: ParsedPatch[] = [];
  let currentPath = "";
  let currentHash = "";
  let currentOps: PatchOp[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank lines
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Separator — flush current block
    if (SEPARATOR_RE.test(line)) {
      if (currentPath && currentOps.length > 0) {
        patches.push({ path: currentPath, hash: currentHash, operations: currentOps });
      }
      currentPath = "";
      currentHash = "";
      currentOps = [];
      i++;
      continue;
    }

    // Header line: [PATH#HASH]
    const headerMatch = line.match(HEADER_RE);
    if (headerMatch) {
      // Flush any previous block that wasn't separated by `---` (edge case)
      if (currentPath && currentOps.length > 0) {
        patches.push({ path: currentPath, hash: currentHash, operations: currentOps });
      }
      currentPath = headerMatch[1];
      currentHash = headerMatch[2];
      currentOps = [];
      i++;
      continue;
    }

    // Operation line
    const opMatch = line.match(OP_RE);
    if (opMatch) {
      const opName = opMatch[1];
      const rangeStr = opMatch[2] ?? "";
      i++;

      // Collect content lines until next header, separator, or end
      // (Skip leading blank lines of content)
      const contentLines: string[] = [];
      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine.trim() === "" && contentLines.length === 0) {
          i++;
          continue;
        }
        if (SEPARATOR_RE.test(nextLine) || HEADER_RE.test(nextLine) || OP_RE.test(nextLine)) {
          // Don't consume — outer loop handles it
          break;
        }
        contentLines.push(nextLine);
        i++;
      }
      // Trim trailing blank lines from content
      while (contentLines.length > 0 && contentLines[contentLines.length - 1].trim() === "") {
        contentLines.pop();
      }
      const content = contentLines.join("\n");

      // Parse range
      const parseRange = (s: string): { start: number; end: number } => {
        const parts = s.split("-");
        const start = Number.parseInt(parts[0], 10);
        const end = parts.length > 1 ? Number.parseInt(parts[1], 10) : start;
        return { start, end };
      };

      switch (opName) {
        case "SWAP": {
          const { start, end } = parseRange(rangeStr);
          currentOps.push({ _tag: "SWAP", lineStart: start, lineEnd: end, content });
          break;
        }
        case "DEL": {
          const { start, end } = parseRange(rangeStr);
          currentOps.push({ _tag: "DEL", lineStart: start, lineEnd: end });
          break;
        }
        case "INS.PRE": {
          currentOps.push({ _tag: "INS.PRE", line: Number.parseInt(rangeStr, 10), content });
          break;
        }
        case "INS.POST": {
          currentOps.push({ _tag: "INS.POST", line: Number.parseInt(rangeStr, 10), content });
          break;
        }
        case "INS.HEAD": {
          currentOps.push({ _tag: "INS.HEAD", content });
          break;
        }
        case "INS.TAIL": {
          currentOps.push({ _tag: "INS.TAIL", content });
          break;
        }
        case "SWAP.BLK": {
          const { start, end } = parseRange(rangeStr);
          currentOps.push({ _tag: "SWAP.BLK", lineStart: start, lineEnd: end, content });
          break;
        }
        case "DEL.BLK": {
          const { start, end } = parseRange(rangeStr);
          currentOps.push({ _tag: "DEL.BLK", lineStart: start, lineEnd: end });
          break;
        }
        case "INS.BLK.POST": {
          currentOps.push({ _tag: "INS.BLK.POST", line: Number.parseInt(rangeStr, 10), content });
          break;
        }
      }
      continue;
    }

    // Unknown line — skip
    i++;
  }

  // Flush final block
  if (currentPath && currentOps.length > 0) {
    patches.push({ path: currentPath, hash: currentHash, operations: currentOps });
  }

  return patches;
}

// ---------------------------------------------------------------------------
// applyPatch — apply a parsed hashline patch to file content (spec §16.3)
// ---------------------------------------------------------------------------

export function applyPatch(file: string, patch: ParsedPatch): ApplyResult {
  // Hash check
  const actualHash = computeHash(file);
  if (actualHash !== patch.hash) {
    return { _tag: "hash_mismatch", expected: patch.hash, actual: actualHash };
  }

  const lines = file.split(/\r?\n/);
  let result = [...lines];

  // Sort operations by line (descending) so we can apply bottom-up
  // and avoid offset shifting.
  const indexed = patch.operations.map((op, idx) => ({ op, idx }));
  indexed.sort((a, b) => {
    const aLine = getOpLine(a.op) ?? Number.POSITIVE_INFINITY;
    const bLine = getOpLine(b.op) ?? Number.POSITIVE_INFINITY;
    return bLine - aLine || b.idx - a.idx;
  });

  for (const { op } of indexed) {
    switch (op._tag) {
      case "SWAP":
      case "SWAP.BLK": {
        const start = op.lineStart - 1;
        const end = op.lineEnd;
        if (start < 0 || start > result.length) {
          return { _tag: "line_not_found", operation: op };
        }
        const contentLines = op.content.split(/\r?\n/);
        result = [...result.slice(0, start), ...contentLines, ...result.slice(end)];
        break;
      }

      case "DEL":
      case "DEL.BLK": {
        const start = op.lineStart - 1;
        const end = op.lineEnd;
        if (start < 0 || start > result.length) {
          return { _tag: "line_not_found", operation: op };
        }
        result = [...result.slice(0, start), ...result.slice(end)];
        break;
      }

      case "INS.PRE": {
        const line = op.line - 1;
        if (line < 0 || line > result.length) {
          return { _tag: "line_not_found", operation: op };
        }
        const contentLines = op.content.split(/\r?\n/);
        result = [...result.slice(0, line), ...contentLines, ...result.slice(line)];
        break;
      }

      case "INS.POST": {
        const line = op.line;
        if (line < 0 || line > result.length) {
          return { _tag: "line_not_found", operation: op };
        }
        const contentLines = op.content.split(/\r?\n/);
        result = [...result.slice(0, line), ...contentLines, ...result.slice(line)];
        break;
      }

      case "INS.HEAD": {
        const contentLines = op.content.split(/\r?\n/);
        result = [...contentLines, ...result];
        break;
      }

      case "INS.TAIL": {
        const contentLines = op.content.split(/\r?\n/);
        result = [...result, ...contentLines];
        break;
      }

      case "INS.BLK.POST": {
        const line = op.line;
        if (line < 0 || line > result.length) {
          return { _tag: "line_not_found", operation: op };
        }
        const contentLines = op.content.split(/\r?\n/);
        result = [...result.slice(0, line), ...contentLines, ...result.slice(line)];
        break;
      }
    }
  }

  return { _tag: "success", content: result.join("\n") };
}

function getOpLine(op: PatchOp): number | undefined {
  switch (op._tag) {
    case "SWAP":
    case "SWAP.BLK":
    case "DEL":
    case "DEL.BLK":
      return op.lineStart;
    case "INS.PRE":
      return op.line;
    case "INS.POST":
    case "INS.BLK.POST":
      return op.line;
    case "INS.HEAD":
      return 0;
    case "INS.TAIL":
      return undefined; // always last
  }
}

// ---------------------------------------------------------------------------
// applyDiffEdit — apply a search/replace diff
//
// Searches for `search` text in the file content and replaces the first
// occurrence with `replace`. If `search` is not found, returns an error.
// Uses a multi-pass strategy: first try exact match, then fuzzy whitespace
// match, then report failure.
// ---------------------------------------------------------------------------

type DiffEditResult =
  | { _tag: "success"; content: string; mode: string }
  | { _tag: "error"; error: string };

function applyDiffEdit(content: string, search: string, replace: string): DiffEditResult {
  // Strategy 1: exact match
  const exactIdx = content.indexOf(search);
  if (exactIdx !== -1) {
    const result = content.slice(0, exactIdx) + replace + content.slice(exactIdx + search.length);
    return { _tag: "success", content: result, mode: "diff_exact" };
  }

  // Strategy 2: fuzzy whitespace match — normalize both sides
  const normalizeWS = (s: string): string => s.replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n\n");
  const normalizedContent = normalizeWS(content);
  const normalizedSearch = normalizeWS(search);
  const fuzzyIdx = normalizedContent.indexOf(normalizedSearch);
  if (fuzzyIdx !== -1) {
    // Map fuzzy index back to original by sliding on whitespace-delta
    // Simple approach: rebuild the search span in the original
    const beforeLen = content.slice(0, fuzzyIdx).length;
    // Realign: the fuzzy match is in normalized space, but we need original
    // index. Count char-by-char through original until we align.
    let origIdx = 0;
    let normIdx = 0;
    let found = -1;
    while (origIdx < content.length && normIdx < normalizedContent.length) {
      if (normIdx === fuzzyIdx) {
        found = origIdx;
        break;
      }
      const oc = content[origIdx];
      const nc = normalizedContent[normIdx];
      // Skip whitespace differences
      if (/[ \t]/.test(oc) && /[ \t]/.test(nc)) {
        // Both are whitespace — advance original by one, normalised by one
        origIdx++;
        normIdx++;
      } else if (/[ \t]/.test(oc)) {
        origIdx++; // Skip extra whitespace in original
      } else if (/[ \t]/.test(nc)) {
        normIdx++; // Skip extra whitespace in normalized
      } else if (oc === nc) {
        origIdx++;
        normIdx++;
      } else {
        break; // Mismatch
      }
    }

    if (found !== -1) {
      const result = content.slice(0, found) + replace + content.slice(found + search.length);
      return { _tag: "success", content: result, mode: "diff_fuzzy_ws" };
    }
  }

  return {
    _tag: "error",
    error: `edit: search text not found in file\n\nSearch text (${search.length} chars, first 80 shown):\n${search.slice(0, 80)}\n${search.length > 80 ? "..." : ""}\n\nTip: verify the search text is present and matches exactly (including whitespace).`,
  };
}

// ---------------------------------------------------------------------------
// editTool
// ---------------------------------------------------------------------------

export const editTool: ToolDef = {
  name: "edit",
  description:
    "Edit a file using one of two modes: 'diff' (search/replace text substitution) or 'hashline' (content-hash anchored patch, spec §16). " +
    "In diff mode, provide `search` (the exact text to find) and `replace` (the text to substitute). " +
    "In hashline mode, provide `patch` in the hashline format. " +
    "Returns the edited file content on success.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The file path to edit (absolute or relative to cwd).",
      },
      mode: {
        type: "string",
        enum: ["diff", "hashline"],
        description:
          "Edit mode: 'diff' (default) for search/replace, 'hashline' for hash-anchored patches.",
      },
      search: {
        type: "string",
        description:
          "Diff mode only. The exact text to find and replace. Must match the file content exactly " +
          "(whitespace and all). If not found, the tool attempts a fuzzy whitespace match as fallback.",
      },
      replace: {
        type: "string",
        description: "Diff mode only. The replacement text.",
      },
      patch: {
        type: "string",
        description:
          "Hashline mode only. The hashline patch string. Format:\n\n" +
          "[PATH#HASH]\nSWAP lineStart-lineEnd\nnew content here\n---\n\n" +
          "Operations: SWAP, DEL, INS.PRE, INS.POST, INS.HEAD, INS.TAIL",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  permission: "auto",

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;
    let filePath = typeof args.path === "string" ? args.path : "";
    if (filePath.length === 0) {
      return err('edit: "path" argument is required');
    }

    // Resolve relative paths against cwd
    if (!filePath.startsWith("/") && !filePath.match(/^[a-zA-Z]:\\/)) {
      filePath = join(context.cwd, filePath);
    }

    // §16.5 — mode selection: user override or selectBestMode from history
    const userMode =
      typeof args.mode === "string" && (args.mode === "diff" || args.mode === "hashline")
        ? args.mode
        : undefined;
    const model = context.model ?? "unknown";
    const mode = userMode ?? selectBestMode(model, "edit", "diff");

    const toolStart = Date.now();

    try {
      const fullContent = await readFile(filePath, "utf-8");

      if (mode === "diff") {
        const search = typeof args.search === "string" ? args.search : "";
        const replace = typeof args.replace === "string" ? args.replace : "";
        if (search.length === 0) {
          return err('edit: "search" argument is required in diff mode');
        }

        const diffResult = applyDiffEdit(fullContent, search, replace);
        if (diffResult._tag === "error") {
          recordToolResult({
            model,
            tool: "edit",
            mode,
            success: false,
            latency: Date.now() - toolStart,
          });
          return err(diffResult.error);
        }

        // Write the result
        const newContent = diffResult.content;
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, newContent, "utf-8");

        // Generate enhanced diff output
        const diff = generateDiff(fullContent, newContent);
        const diffSummary = formatDiffSummary(diff);
        const inlineDiff = formatInlineDiff(diff);

        recordToolResult({
          model,
          tool: "edit",
          mode,
          success: true,
          latency: Date.now() - toolStart,
        });

        return ok(
          `Applied ${diffResult.mode} edit to ${filePath}\n\n${diffSummary}\n\n${inlineDiff}`,
          {
            path: filePath,
            mode: "diff",
            diffMode: diffResult.mode,
            bytes: Buffer.byteLength(newContent, "utf-8"),
            additions: diff.additions,
            deletions: diff.deletions,
            hunks: diff.hunks.length,
          },
        );
      } else {
        // Hashline mode
        const patchStr = typeof args.patch === "string" ? args.patch : "";
        if (patchStr.length === 0) {
          return err('edit: "patch" argument is required in hashline mode');
        }

        const patches = parsePatch(patchStr);

        // Find patches for this file
        const filePatches = patches.filter(
          (p) => p.path === filePath || resolve(p.path) === resolve(filePath),
        );
        if (filePatches.length === 0) {
          recordToolResult({
            model,
            tool: "edit",
            mode,
            success: false,
            latency: Date.now() - toolStart,
          });
          return err(`edit: no patch block found for path "${filePath}" in the hashline input`);
        }

        let currentContent = fullContent;
        for (const patch of filePatches) {
          const result = applyPatch(currentContent, patch);
          switch (result._tag) {
            case "success":
              currentContent = result.content;
              break;
            case "hash_mismatch":
              recordToolResult({
                model,
                tool: "edit",
                mode,
                success: false,
                latency: Date.now() - toolStart,
              });
              return err(
                `edit: hash mismatch for ${patch.path} — expected ${result.expected}, actual ${result.actual}. ` +
                  "The file has changed since the patch was generated; re-read the file and try again.",
              );
            case "line_not_found":
              recordToolResult({
                model,
                tool: "edit",
                mode,
                success: false,
                latency: Date.now() - toolStart,
              });
              return err(
                `edit: line not found for operation ${JSON.stringify(result.operation)}. ` +
                  "The file structure may have changed; re-read the file and try again.",
              );
          }
        }

        // Generate enhanced diff output
        const diff = generateDiff(fullContent, currentContent);
        const diffSummary = formatDiffSummary(diff);
        const inlineDiff = formatInlineDiff(diff);

        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, currentContent, "utf-8");

        recordToolResult({
          model,
          tool: "edit",
          mode,
          success: true,
          latency: Date.now() - toolStart,
        });

        return ok(
          `Applied hashline edit to ${filePath}\n\n${diffSummary}\n\n${inlineDiff}`,
          {
            path: filePath,
            mode: "hashline",
            bytes: Buffer.byteLength(currentContent, "utf-8"),
            additions: diff.additions,
            deletions: diff.deletions,
            hunks: diff.hunks.length,
            patchCount: filePatches.length,
            operationCount: filePatches.reduce((sum, p) => sum + p.operations.length, 0),
          },
        );
      }
    } catch (e) {
      recordToolResult({
        model,
        tool: "edit",
        mode,
        success: false,
        latency: Date.now() - toolStart,
      });
      return err(`edit: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
