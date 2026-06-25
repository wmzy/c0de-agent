// Built-in `ast_edit` tool (§17.2).
//
// AST structural edit: uses pattern templates with metavariable support to
// find and replace code across files. By default returns a preview of changes;
// user confirmation is required before applying (permission: 'ask').
//
// Parameters:
//   ops    — array of { pattern, replacement } rewrite operations
//   paths  — files/directories to apply edits within
//
// Conventions: data + functions, no class, no this.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { ok, err, type ToolContext, type ToolDef, type ToolResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ASTEditOp = {
  pattern: string;
  replacement: string;
};

type PatternSegment =
  | { _tag: "literal"; value: string }
  | { _tag: "capture"; name: string }
  | { _tag: "capture_multi"; name: string };

export type ASTEditPreview = {
  file: string;
  range: { start: number; end: number };
  match: string;
  replacement: string;
};

// ---------------------------------------------------------------------------
// Pattern parsing — same as ast_grep
// ---------------------------------------------------------------------------

function parsePattern(pattern: string): PatternSegment[] {
  const segments: PatternSegment[] = [];
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "$") {
      const start = i;
      i++;
      if (
        i < pattern.length &&
        pattern[i] === "$" &&
        i + 1 < pattern.length &&
        pattern[i + 1] === "$"
      ) {
        // $$$NAME — multi capture
        i += 2;
        const nameStart = i;
        while (i < pattern.length && /[A-Z_]\w*/.test(pattern[i])) i++;
        if (i > nameStart) {
          segments.push({ _tag: "capture_multi", name: pattern.slice(nameStart, i) });
        }
      } else if (i < pattern.length && /[A-Z_]/.test(pattern[i])) {
        const nameStart = i;
        while (i < pattern.length && /\w/.test(pattern[i])) i++;
        segments.push({ _tag: "capture", name: pattern.slice(nameStart, i) });
      } else {
        segments.push({ _tag: "literal", value: pattern.slice(start, i) });
      }
    } else {
      segments.push({ _tag: "literal", value: pattern[i] });
      i++;
    }
  }
  return segments;
}

/**
 * Escape regex special characters.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a RegExp for matching, and extract capture group names in order.
 */
function buildPatternRegex(segments: PatternSegment[]): { regex: RegExp; captureNames: string[] } {
  const captureNames: string[] = [];
  let src = "";
  for (const seg of segments) {
    if (seg._tag === "literal") {
      src += escapeRegex(seg.value);
    } else if (seg._tag === "capture") {
      src += "(\\S+)";
      captureNames.push(seg.name);
    } else if (seg._tag === "capture_multi") {
      src += "([\\s\\S]*?)";
      captureNames.push(seg.name);
    }
  }
  return { regex: new RegExp(src, "g"), captureNames };
}

/**
 * Build a replacement string from a replacement template and captured values.
 * $NAME is replaced by captured value; $$$NAME is replaced by captured multi-value.
 */
function buildReplacement(template: string, captures: Record<string, string>): string {
  return template.replace(/\$(\$(\$)?)?([A-Z_]\w*)/g, (_m, d1, _d2d3, name) => {
    if (d1) {
      // $$$NAME or $$NAME — treat as multi capture reference
      if (captures[name] !== undefined) return captures[name];
      return "";
    }
    // $NAME
    if (captures[name] !== undefined) return captures[name];
    return "";
  });
}

/**
 * Apply a rewrite operation to file content.
 * Returns the modified content and a list of change previews.
 */
function applyRewrite(
  content: string,
  segments: PatternSegment[],
  replacementTemplate: string,
): { content: string; previews: ASTEditPreview[]; filePath: string } {
  const { regex, captureNames } = buildPatternRegex(segments);
  const previews: ASTEditPreview[] = [];
  const lines = content.split("\n");

  let result = content;
  let offsetShift = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(result)) !== null) {
    const matchedText = match[0];
    const matchIndex = match.index;

    // Capture values
    const captures: Record<string, string> = {};
    for (let ci = 0; ci < captureNames.length; ci++) {
      captures[captureNames[ci]] = match[ci + 1] ?? "";
    }

    const newText = buildReplacement(replacementTemplate, captures);
    const preview: ASTEditPreview = {
      file: "",
      range: { start: 0, end: 0 },
      match: matchedText,
      replacement: newText,
    };
    previews.push(preview);

    // Apply replacement using adjusted index
    const before = result.slice(0, matchIndex - offsetShift);
    const after = result.slice(matchIndex - offsetShift + matchedText.length);
    const newContent = before + newText + after;
    offsetShift += result.length - newContent.length;
    result = newContent;

    // Reset regex state on the new content
    regex.lastIndex = 0;
  }

  return { content: result, previews, filePath: "" };
}

/**
 * Compute line range from an offset in content.
 */
function offsetToRange(
  content: string,
  offset: number,
  length: number,
): { start: number; end: number } {
  const before = content.slice(0, offset);
  const start = before.split("\n").length;
  const end =
    before.split("\n").length + content.slice(offset, offset + length).split("\n").length - 1;
  return { start, end };
}

/**
 * Walk directories to collect file paths (shared pattern).
 */
async function collectFiles(
  dir: string,
  base: string,
  depth: number,
  maxDepth: number,
  results: string[],
): Promise<void> {
  if (depth > maxDepth) return;
  const { readdir, stat } = await import("node:fs/promises");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let s: import("node:fs").Stats;
    try {
      s = await stat(fullPath);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      if (
        entry === ".git" ||
        entry === "node_modules" ||
        entry === ".next" ||
        entry === "dist" ||
        entry === "build" ||
        entry === "target"
      )
        continue;
      await collectFiles(fullPath, base, depth + 1, maxDepth, results);
    } else if (s.isFile()) {
      results.push(fullPath);
    }
  }
}

// ---------------------------------------------------------------------------
// astEditTool
// ---------------------------------------------------------------------------

export const astEditTool: ToolDef = {
  name: "ast_edit",
  description:
    "Edit code files using AST pattern templates with metavariable capture and replacement.\n" +
    "Metavariables: $NAME captures a single word, $$$NAME captures zero-or-more tokens.\n" +
    "Each op has a pattern (search) and replacement (template using captured values).\n" +
    "By default returns a preview of changes. Apply with `apply: true`.\n" +
    "Permission is 'ask' — the executor will prompt for confirmation before applying edits.",
  parameters: {
    type: "object",
    properties: {
      ops: {
        type: "array",
        description:
          "Array of rewrite operations. Each op has a pattern (search template with $NAME/$$$NAME " +
          "metavariables) and replacement (output template referencing captured $NAME values).",
        items: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description:
                "AST pattern with metavariables ($NAME for single node, $$$NAME for multi). " +
                "Example: 'console.log($ARG)' matches console.log(x) and captures x.",
            },
            replacement: {
              type: "string",
              description:
                "Replacement template. Refer to captured metavariables with $NAME syntax. " +
                "Example: 'logger.info($ARG)' replaces console.log(x) with logger.info(x).",
            },
          },
          required: ["pattern", "replacement"],
          additionalProperties: false,
        },
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description:
          "Files or directories to apply edits to. Directories are walked recursively " +
          "(skipping .git, node_modules, dist, build, target).",
      },
      apply: {
        type: "boolean",
        description:
          "When true, apply the edits to files. When false (default), return a preview of changes " +
          "without modifying anything.",
        default: false,
      },
    },
    required: ["ops", "paths"],
    additionalProperties: false,
  },
  permission: "ask",

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;

    const rawOps = Array.isArray(args.ops) ? (args.ops as Record<string, unknown>[]) : [];
    if (rawOps.length === 0) {
      return err('ast_edit: "ops" argument is required with at least one operation');
    }

    const rawPaths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
    if (rawPaths.length === 0) {
      return err('ast_edit: "paths" argument is required');
    }

    const applyImmediately = args.apply === true;

    // Parse ops
    const ops: ASTEditOp[] = [];
    for (const rawOp of rawOps) {
      const pattern = typeof rawOp.pattern === "string" ? rawOp.pattern : "";
      const replacement = typeof rawOp.replacement === "string" ? rawOp.replacement : "";
      if (pattern.length === 0) {
        return err('ast_edit: each op must have a non-empty "pattern"');
      }
      ops.push({ pattern, replacement });
    }

    // Collect files
    const allFiles: string[] = [];
    for (const rawPath of rawPaths) {
      const resolvedPath = resolve(context.cwd, rawPath);
      const { stat } = await import("node:fs/promises");
      let s: import("node:fs").Stats;
      try {
        s = await stat(resolvedPath);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        const base = resolve(context.cwd);
        await collectFiles(resolvedPath, base, 0, 30, allFiles);
      } else if (s.isFile()) {
        allFiles.push(resolvedPath);
      }
    }

    if (allFiles.length === 0) {
      return err("ast_edit: no files matched the provided paths");
    }

    // Process each file
    const allPreviews: {
      file: string;
      range: { start: number; end: number };
      match: string;
      replacement: string;
    }[] = [];
    const filesChanged: string[] = [];

    for (const filePath of allFiles) {
      if (context.abort.aborted) {
        return err("ast_edit: aborted");
      }

      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }

      let currentContent = content;
      let fileModified = false;

      for (const op of ops) {
        const segments = parsePattern(op.pattern);
        const { regex, captureNames } = buildPatternRegex(segments);

        // Build replacement
        let match: RegExpExecArray | null;
        while ((match = regex.exec(currentContent)) !== null) {
          const matchedText = match[0];
          const matchIndex = match.index;

          const captures: Record<string, string> = {};
          for (let ci = 0; ci < captureNames.length; ci++) {
            captures[captureNames[ci]] = match[ci + 1] ?? "";
          }

          const newText = buildReplacement(op.replacement, captures);
          const range = offsetToRange(currentContent, matchIndex, matchedText.length);

          allPreviews.push({
            file: filePath,
            range,
            match: matchedText,
            replacement: newText,
          });

          if (applyImmediately) {
            currentContent =
              currentContent.slice(0, matchIndex) +
              newText +
              currentContent.slice(matchIndex + matchedText.length);
            fileModified = true;
          }
        }
      }

      if (fileModified && applyImmediately) {
        try {
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, currentContent, "utf-8");
          filesChanged.push(filePath);
        } catch (error) {
          return err(`ast_edit: failed to write ${filePath}: ${(error as Error).message}`);
        }
      }
    }

    if (allPreviews.length === 0) {
      return ok("(no matches found for any operation)", { count: 0 });
    }

    // Build output
    const lines: string[] = [];
    if (applyImmediately) {
      lines.push(`Applied ${allPreviews.length} edit(s) across ${filesChanged.length} file(s):`);
      lines.push("");
    } else {
      lines.push(`Preview — ${allPreviews.length} match(es) found (use "apply: true" to apply):`);
      lines.push("");
    }

    // Group by file
    const grouped = new Map<string, typeof allPreviews>();
    for (const p of allPreviews) {
      const existing = grouped.get(p.file) ?? [];
      existing.push(p);
      grouped.set(p.file, existing);
    }

    for (const [file, previews] of grouped) {
      const relFile = relative(resolve(context.cwd), file);
      lines.push(`  ${relFile}:`);
      for (const p of previews) {
        const lineInfo =
          p.range.start === p.range.end ? `L${p.range.start}` : `L${p.range.start}-L${p.range.end}`;
        lines.push(`    ${lineInfo}: "${p.match.trim()}"`);
        lines.push(`       -> "${p.replacement.trim()}"`);
      }
    }

    return ok(lines.join("\n"), {
      count: allPreviews.length,
      filesChanged: filesChanged.length,
      applied: applyImmediately,
      affectedFiles: filesChanged,
    });
  },
};
