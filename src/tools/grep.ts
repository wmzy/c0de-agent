// Built-in `grep` tool (spec §5.4).
//
// Searches file contents by regular expression. Returns matching file paths
// with line numbers and matched lines.
//
// Conventions: data + functions, no class. Returns ToolResult variants.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  createURLRegistry,
  registerBuiltInResolvers,
  resolveURL,
  type URLRegistry,
  type URLResolveContext,
} from "../core/url-registry";
import { ok, err, type ToolContext, type ToolDef, type ToolResult } from "./types";

// ---------------------------------------------------------------------------
// Recursive directory walk
// ---------------------------------------------------------------------------

function shouldSkipDir(name: string): boolean {
  return (
    name === ".git" ||
    name === "node_modules" ||
    name === ".next" ||
    name === "dist" ||
    name === "build" ||
    name === "target" ||
    name === ".c0de" ||
    name.startsWith(".")
  );
}

function isBinary(buf: Buffer, sampleSize = 1024): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, sampleSize));
  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i];
    // Null byte or control character (except common text controls: tab, newline, carriage return)
    if (byte === 0 || (byte < 8 && byte !== 0) || (byte > 13 && byte < 32)) {
      return true;
    }
  }
  return false;
}

async function collectFiles(
  dir: string,
  base: string,
  depth: number,
  maxDepth: number,
  results: string[],
  globInclude?: string[],
  globExclude?: string[],
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
      await collectFiles(fullPath, base, depth + 1, maxDepth, results, globInclude, globExclude);
    } else if (s.isFile() && s.size > 0) {
      // Apply include/exclude patterns
      if (globInclude && globInclude.length > 0) {
        const included = globInclude.some((pat) => simpleMatch(pat, relPath));
        if (!included) continue;
      }
      if (globExclude && globExclude.length > 0) {
        const excluded = globExclude.some((pat) => simpleMatch(pat, relPath));
        if (excluded) continue;
      }
      results.push(fullPath);
    }
  }
}

/**
 * Simple glob match: supports * (non-/), ** (any depth), {a,b}.
 */
function simpleMatch(pattern: string, filePath: string): boolean {
  // Convert to regex
  let src = "";
  let i = 0;
  const len = pattern.length;

  // Handle ** at start: "**/*.ts" should match "foo/bar.ts"
  // We prepend (.*/)? so the pattern can start anywhere in the path

  while (i < len) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") {
      src += "(?:.*/)?";
      i += 3;
    } else if (ch === "*" && pattern[i + 1] === "*" && i + 2 >= len) {
      src += ".*";
      i += 2;
    } else if (ch === "*") {
      src += "[^/]*";
      i++;
    } else if (ch === "?") {
      src += "[^/]";
      i++;
    } else if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) {
        src += "\\{";
        i++;
      } else {
        const inner = pattern.slice(i + 1, close);
        const alts = inner.split(",").map((a) =>
          a
            .replace(/[.+^${}()|\\]/g, "\\$&")
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, "[^/]"),
        );
        src += `(?:${alts.join("|")})`;
        i = close + 1;
      }
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        src += "\\[";
        i++;
      } else {
        src += pattern.slice(i, close + 1).replace(/!/, "^");
        i = close + 1;
      }
    } else {
      src += /[.+^${}()|\\]/.test(ch) ? "\\" + ch : ch;
      i++;
    }
  }

  const re = new RegExp(`^${src}$`);
  return re.test(filePath);
}

// ---------------------------------------------------------------------------
// URL scheme detection + lazy registry singleton
// ---------------------------------------------------------------------------

/** Match a scheme prefix like `file://`, `skill://`, `agent://`, etc. */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//;

function hasURLScheme(value: string): boolean {
  return SCHEME_RE.test(value);
}

let _urlRegistry: URLRegistry | undefined;

function getURLRegistry(): URLRegistry {
  if (!_urlRegistry) {
    _urlRegistry = createURLRegistry();
    registerBuiltInResolvers(_urlRegistry);
  }
  return _urlRegistry;
}

// ---------------------------------------------------------------------------
// grepTool
// ---------------------------------------------------------------------------

export const grepTool: ToolDef = {
  name: "grep",
  description:
    "Search file contents by regular expression. Returns matching files with line numbers and matched lines. " +
    "Searches from the session working directory. Skips .git, node_modules, dist, build, and binary files. " +
    "Supports internal URL schemes (file://, skill://, agent://, pr://, issue://) via the pattern argument.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The regular expression pattern to search for. Uses JavaScript RegExp syntax.",
      },
      include: {
        type: "string",
        description:
          "Optional glob pattern to filter which files to search (e.g. '**/*.ts', '**/*.{js,ts}').",
      },
      exclude: {
        type: "string",
        description: "Optional glob pattern to exclude files from search (e.g. '**/test/**').",
      },
      maxDepth: {
        type: "integer",
        description: "Maximum directory depth to traverse (default: 15).",
        default: 15,
        minimum: 1,
      },
      limit: {
        type: "integer",
        description: "Maximum number of match results to return (default: 100).",
        default: 100,
        minimum: 1,
        maximum: 10000,
      },
      contextLines: {
        type: "integer",
        description: "Number of lines of context before/after each match (default: 0).",
        default: 0,
        minimum: 0,
        maximum: 10,
      },
      caseSensitive: {
        type: "boolean",
        description: "Whether the search is case-sensitive (default: true).",
      },
      cwd: {
        type: "string",
        description:
          "Optional override of the working directory (relative to session cwd or absolute).",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  permission: "auto",

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;
    const patternStr = typeof args.pattern === "string" ? args.pattern : "";
    if (patternStr.length === 0) {
      return err('grep: "pattern" argument is required');
    }

    const caseSensitive = args.caseSensitive !== false;
    const limit = typeof args.limit === "number" && args.limit >= 1 ? Math.floor(args.limit) : 100;
    const contextLines =
      typeof args.contextLines === "number" && args.contextLines >= 0
        ? Math.floor(args.contextLines)
        : 0;

    type Match = {
      file: string;
      line: number;
      content: string;
      context: string[];
    };

    // --- URL scheme: resolve URL and search within resolved content (§3.10) ---
    if (hasURLScheme(patternStr)) {
      try {
        const registry = getURLRegistry();
        const urlCtx: URLResolveContext = { cwd: context.cwd };
        const content = await resolveURL(registry, patternStr, urlCtx);
        const lines = content.split(/\r?\n/);
        const re = new RegExp(".*", caseSensitive ? "gm" : "gim");

        const matches: Match[] = [];
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          if (matches.length >= limit) break;
          const line = lines[lineIdx];
          if (re.test(line)) {
            const ctx: string[] = [];
            if (contextLines > 0) {
              const ctxStart = Math.max(0, lineIdx - contextLines);
              const ctxEnd = Math.min(lines.length, lineIdx + contextLines + 1);
              for (let c = ctxStart; c < ctxEnd; c++) {
                ctx.push(`  ${c + 1}: ${lines[c]}`);
              }
            }
            matches.push({
              file: patternStr,
              line: lineIdx + 1,
              content: line,
              context: ctx,
            });
          }
        }

        if (matches.length === 0) {
          return ok(`(no matches for URL "${patternStr}")`, {
            pattern: patternStr,
            count: 0,
          });
        }

        const outputLines: string[] = [];
        for (const match of matches) {
          if (match.context.length > 0) {
            outputLines.push(...match.context);
          } else {
            outputLines.push(`  ${match.line}: ${match.content}`);
          }
        }

        return ok(outputLines.join("\n"), {
          pattern: patternStr,
          count: matches.length,
          url: patternStr,
          truncated: matches.length >= limit,
        });
      } catch (e) {
        return err(`grep: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // --- Original file search logic ---
    const include =
      typeof args.include === "string" && args.include.length > 0 ? args.include : undefined;
    const exclude =
      typeof args.exclude === "string" && args.exclude.length > 0 ? args.exclude : undefined;
    const maxDepth =
      typeof args.maxDepth === "number" && args.maxDepth >= 1 ? Math.floor(args.maxDepth) : 15;
    const cwdRaw = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : context.cwd;
    const searchDir = resolve(context.cwd, cwdRaw);

    let re: RegExp;
    try {
      re = new RegExp(patternStr, caseSensitive ? "gm" : "gim");
    } catch (e) {
      return err(`grep: invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`);
    }

    const includeArr = include ? [include] : undefined;
    const excludeArr = exclude ? [exclude] : undefined;
    const files: string[] = [];
    await collectFiles(searchDir, searchDir, 0, maxDepth, files, includeArr, excludeArr);

    const matches: Match[] = [];
    for (const filePath of files) {
      if (matches.length >= limit) break;

      let content: string;
      try {
        const buf = await readFile(filePath);
        if (isBinary(buf)) continue;
        content = buf.toString("utf-8");
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      re.lastIndex = 0;

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        if (matches.length >= limit) break;
        const line = lines[lineIdx];
        const lineRe = new RegExp(patternStr, caseSensitive ? "g" : "gi");
        if (lineRe.test(line)) {
          const relFile = relative(searchDir, filePath);
          const ctx: string[] = [];
          if (contextLines > 0) {
            const ctxStart = Math.max(0, lineIdx - contextLines);
            const ctxEnd = Math.min(lines.length, lineIdx + contextLines + 1);
            for (let c = ctxStart; c < ctxEnd; c++) {
              ctx.push(`  ${c + 1}: ${lines[c]}`);
            }
          }
          matches.push({
            file: relFile,
            line: lineIdx + 1,
            content: line,
            context: ctx,
          });
        }
      }
    }

    if (matches.length === 0) {
      return ok(`(no matches for pattern "${patternStr}")`, {
        pattern: patternStr,
        filesSearched: files.length,
        count: 0,
      });
    }

    const outputLines: string[] = [];
    let currentFile = "";
    for (const match of matches) {
      if (match.file !== currentFile) {
        if (outputLines.length > 0) outputLines.push("");
        outputLines.push(`${match.file}:`);
        currentFile = match.file;
      }
      if (match.context.length > 0) {
        outputLines.push(...match.context);
      } else {
        outputLines.push(`  ${match.line}: ${match.content}`);
      }
    }

    return ok(outputLines.join("\n"), {
      pattern: patternStr,
      count: matches.length,
      filesSearched: files.length,
      truncated: matches.length >= limit,
    });
  },
};
