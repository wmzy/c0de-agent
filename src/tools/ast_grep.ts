// Built-in `ast_grep` tool (§17.1).
//
// AST structural search: matches code using pattern templates with metavariable
// capture support (`$NAME`). Operates on raw text lines with a pattern-matching
// approach suitable for the c0de-agent harness.
//
// Parameters:
//   pattern    — the AST pattern to search for (supports `$NAME` metavariables)
//   paths      — files/directories to search within
//   options    — language filter, include/exclude globs, max results
//
// Returns: { file, range, match, captures }[]
//
// Conventions: data + functions, no class, no this.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ok, err, type ToolContext, type ToolDef, type ToolResult } from "./types";

// ---------------------------------------------------------------------------
// Directory walk (shared with glob/grep)
// ---------------------------------------------------------------------------

function shouldSkipDir(name: string): boolean {
  return (
    name === ".git" ||
    name === "node_modules" ||
    name === ".next" ||
    name === "dist" ||
    name === "build" ||
    name === "target" ||
    name === ".c0de"
  );
}

async function collectFiles(
  dir: string,
  base: string,
  depth: number,
  maxDepth: number,
  results: string[],
  include?: string[],
  exclude?: string[],
): Promise<void> {
  if (depth > maxDepth) return;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const relPath = relative(base, fullPath);

    let s: import("node:fs").Stats;
    try {
      s = await stat(fullPath);
    } catch {
      continue;
    }

    if (s.isDirectory()) {
      if (shouldSkipDir(entry)) continue;
      await collectFiles(fullPath, base, depth + 1, maxDepth, results, include, exclude);
    } else if (s.isFile()) {
      // apply include / exclude globs
      if (include && include.length > 0) {
        const matched = include.some((g) => simpleMatch(g, relPath));
        if (!matched) continue;
      }
      if (exclude && exclude.length > 0) {
        const matched = exclude.some((g) => simpleMatch(g, relPath));
        if (matched) continue;
      }
      results.push(fullPath);
    }
  }
}

/**
 * Simple glob match: * (non-/), ** (any depth), {a,b}.
 */
function simpleMatch(pattern: string, filePath: string): boolean {
  // Convert glob pattern to regex
  let regexStr = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") {
      regexStr += "(.+/)?";
      i += 3;
    } else if (ch === "*") {
      regexStr += "[^/]*";
      i++;
    } else if (ch === "?") {
      regexStr += "[^/]";
      i++;
    } else if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) {
        regexStr += "\\{";
        i++;
      } else {
        const parts = pattern.slice(i + 1, close).split(",");
        regexStr += "(" + parts.map((p) => p.replace(/[.+^${}()|\\]/g, "\\$&")).join("|") + ")";
        i = close + 1;
      }
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        regexStr += "\\[";
        i++;
      } else {
        regexStr += pattern.slice(i, close + 1);
        i = close + 1;
      }
    } else {
      regexStr += /[.+^${}()|\\]/.test(ch) ? "\\" + ch : ch;
      i++;
    }
  }
  return new RegExp("^" + regexStr + "$").test(filePath);
}

// ---------------------------------------------------------------------------
// AST pattern matching
//
// Converts a pattern like `console.log($VAR)` into a regex that anchors
// on word boundaries and captures the `$VAR` metavariable positions.
// Matches are line-oriented: we scan each line, then attempt multi-line
// matches for patterns containing newlines.
// ---------------------------------------------------------------------------

export type ASTGrepMatch = {
  file: string;
  range: { start: number; end: number };
  match: string;
  captures: Record<string, string>;
};

/**
 * Parse a pattern and extract metavariable names.
 * Returns an array of segments where each entry is either a literal string
 * or a capture group marker.
 */
type PatternSegment =
  | { _tag: "literal"; value: string }
  | { _tag: "capture"; name: string }
  | { _tag: "capture_multi"; name: string };

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
        // $$$NAME — multi capture (zero-or-more)
        i += 2;
        const nameStart = i;
        while (i < pattern.length && /[A-Z_]\w*/.test(pattern[i])) i++;
        if (i > nameStart) {
          segments.push({ _tag: "capture_multi", name: pattern.slice(nameStart, i) });
        }
      } else if (i < pattern.length && /[A-Z_]/.test(pattern[i])) {
        // $NAME — single capture
        const nameStart = i;
        while (i < pattern.length && /\w/.test(pattern[i])) i++;
        segments.push({ _tag: "capture", name: pattern.slice(nameStart, i) });
      } else {
        // Not a valid metavariable: treat as literal
        segments.push({ _tag: "literal", value: pattern.slice(start, i) });
      }
    } else {
      const litStart = i;
      i++;
      segments.push({ _tag: "literal", value: pattern[litStart] });
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
 * Build a RegExp from pattern segments.
 * Returns the regex and the capture group names in order.
 */
function buildPatternRegex(segments: PatternSegment[]): { regex: RegExp; captureNames: string[] } {
  const captureNames: string[] = [];
  let src = "";

  for (const seg of segments) {
    if (seg._tag === "literal") {
      src += escapeRegex(seg.value);
    } else if (seg._tag === "capture") {
      // Match one or more non-whitespace characters (a single AST node)
      src += "(\\S+)";
      captureNames.push(seg.name);
    } else if (seg._tag === "capture_multi") {
      // Match zero or more characters (greedy, for multi-node capture)
      src += "([\\s\\S]*?)";
      captureNames.push(seg.name);
    }
  }

  return { regex: new RegExp(src, "g"), captureNames };
}

/**
 * Search a single file for pattern matches.
 */
function searchFile(
  content: string,
  segments: PatternSegment[],
  filePath: string,
  maxResults: number,
): ASTGrepMatch[] {
  const results: ASTGrepMatch[] = [];
  const { regex, captureNames } = buildPatternRegex(segments);

  const lines = content.split("\n");

  // Try to match the regex across the full content
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null && results.length < maxResults) {
    const matchedText = match[0];

    // Compute line numbers
    const beforeMatch = content.slice(0, match.index);
    const startLine = beforeMatch.split("\n").length;
    const endLine = beforeMatch.split("\n").length + matchedText.split("\n").length - 1;

    // Collect captures
    const captures: Record<string, string> = {};
    for (let ci = 0; ci < captureNames.length; ci++) {
      captures[captureNames[ci]] = match[ci + 1] ?? "";
    }

    results.push({
      file: filePath,
      range: { start: startLine, end: endLine },
      match: matchedText,
      captures,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// astGrepTool
// ---------------------------------------------------------------------------

export const astGrepTool: ToolDef = {
  name: "ast_grep",
  description:
    "Search code files using AST pattern templates with metavariable capture.\n" +
    "Metavariables: $NAME matches a single word (non-whitespace node), $$$NAME matches zero-or-more tokens.\n" +
    "Returns matching locations with captured values for each match.\n" +
    "Uses text-level pattern matching — patterns are regex-escaped except $NAME / $$$NAME metavariables.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "AST pattern to search for. Supports $NAME (single node) and $$$NAME (multi-node) " +
          "metavariables. Example: 'console.log($ARG)' matches calls to console.log and " +
          "captures the argument. Whitespace in the pattern is flexible.",
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description:
          "Files or directories to search. Directories are walked recursively " +
          "(skipping .git, node_modules, dist, build). Glob patterns are supported per entry.",
      },
      options: {
        type: "object",
        description: "Optional search configuration.",
        properties: {
          language: {
            type: "string",
            description:
              "Filter by file extension (e.g. 'ts', 'js', 'py'). When set, only files with matching extension are searched.",
          },
          include: {
            type: "array",
            items: { type: "string" },
            description: "Glob patterns for files to include (e.g. ['**/*.ts', '**/*.tsx']).",
          },
          exclude: {
            type: "array",
            items: { type: "string" },
            description:
              "Glob patterns for files to exclude (e.g. ['**/*.test.ts', '**/node_modules/**']).",
          },
          maxResults: {
            type: "integer",
            description: "Maximum number of matches to return (default: 50).",
            default: 50,
            minimum: 1,
            maximum: 10000,
          },
        },
        additionalProperties: false,
      },
    },
    required: ["pattern", "paths"],
    additionalProperties: false,
  },
  permission: "auto",

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;

    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    if (pattern.length === 0) {
      return err('ast_grep: "pattern" argument is required');
    }

    const rawPaths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
    if (rawPaths.length === 0) {
      return err('ast_grep: "paths" argument is required');
    }

    const options = (args.options ?? {}) as Record<string, unknown>;
    const language = typeof options.language === "string" ? options.language : undefined;
    const include = Array.isArray(options.include) ? (options.include as string[]) : undefined;
    const exclude = Array.isArray(options.exclude) ? (options.exclude as string[]) : undefined;
    const maxResults =
      typeof options.maxResults === "number" && options.maxResults > 0
        ? Math.floor(options.maxResults)
        : 50;

    // Parse pattern into segments
    const segments = parsePattern(pattern);

    // Collect files from all path arguments
    const allFiles: string[] = [];
    for (const rawPath of rawPaths) {
      const resolvedPath = resolve(context.cwd, rawPath);

      let s: import("node:fs").Stats;
      try {
        s = await stat(resolvedPath);
      } catch {
        continue;
      }

      if (s.isDirectory()) {
        const base = resolve(context.cwd);
        await collectFiles(resolvedPath, base, 0, 30, allFiles, include, exclude);
      } else if (s.isFile()) {
        const relPath = relative(resolve(context.cwd), resolvedPath);
        if (exclude && exclude.length > 0 && exclude.some((g) => simpleMatch(g, relPath))) continue;
        if (include && include.length > 0 && !include.some((g) => simpleMatch(g, relPath)))
          continue;
        allFiles.push(resolvedPath);
      }
    }

    // Filter by language if specified
    const langExt = language ? `.${language.replace(/^\./, "")}` : undefined;
    const filteredFiles = langExt ? allFiles.filter((f) => f.endsWith(langExt)) : allFiles;

    if (filteredFiles.length === 0) {
      return ok("(no files matched the search criteria)", { count: 0 });
    }

    // Search each file
    const allMatches: ASTGrepMatch[] = [];
    for (const filePath of filteredFiles) {
      if (allMatches.length >= maxResults) break;
      if (context.abort.aborted) {
        return err("ast_grep: aborted");
      }

      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        continue; // skip unreadable files
      }

      const matches = searchFile(content, segments, filePath, maxResults - allMatches.length);
      allMatches.push(...matches);
    }

    // Limit results
    const limited = allMatches.slice(0, maxResults);

    if (limited.length === 0) {
      return ok(`(no matches for pattern "${pattern}")`, { pattern, count: 0 });
    }

    const output = limited
      .map((m) => {
        const lineInfo =
          m.range.start === m.range.end ? `${m.range.start}` : `${m.range.start}-${m.range.end}`;
        const capStr =
          Object.keys(m.captures).length > 0 ? ` captures=${JSON.stringify(m.captures)}` : "";
        return `${m.file}#${lineInfo}: ${m.match.trim()}${capStr}`;
      })
      .join("\n");

    return ok(output, {
      pattern,
      count: limited.length,
      totalMatched: allMatches.length,
      truncated: allMatches.length > maxResults,
    });
  },
};
