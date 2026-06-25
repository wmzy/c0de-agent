// Built-in `glob` tool (spec §5.4).
//
// Searches for files by glob pattern. Uses a simple recursive directory
// walk with picomatch-style pattern matching via native fs.
//
// Conventions: data + functions, no class. Returns ToolResult variants.

import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ok, err, type ToolContext, type ToolDef, type ToolResult } from "./types";

// ---------------------------------------------------------------------------
// Simple glob matching
//
// Supports: **, *, ?, {a,b}, [abc] patterns
// Uses picomatch-compatible logic — delegates to a minimal recursive matcher.
// ---------------------------------------------------------------------------

/**
 * Convert a glob pattern into a RegExp.
 *
 * Supports the following glob features:
 *   - `**`  — matches zero or more directory levels
 *   - `*`   — matches any characters except `/`
 *   - `?`   — matches a single character except `/`
 *   - `[abc]` / `[!abc]` — character class
 *   - `{a,b}` — alternation (expanded inline)
 */
function globToRegex(pattern: string): RegExp {
  let src = "";

  // Expand {a,b} alternations first: split on commas within braces
  // Simple recursive expansion — handles one level of { }
  const expandBraces = (p: string): string[] => {
    const braceStart = p.indexOf("{");
    if (braceStart === -1) return [p];
    const braceEnd = p.indexOf("}", braceStart);
    if (braceEnd === -1) return [p];

    const prefix = p.slice(0, braceStart);
    const middle = p.slice(braceStart + 1, braceEnd);
    const suffix = p.slice(braceEnd + 1);

    const alternatives = middle.split(",");
    return alternatives.flatMap((alt) => expandBraces(prefix + alt + suffix));
  };

  const patterns = expandBraces(pattern);
  if (patterns.length > 1) {
    const regexes = patterns.map((p) => globToRegex(p).source);
    return new RegExp(`^(?:${regexes.join("|")})$`);
  }

  let i = 0;
  const len = pattern.length;

  while (i < len) {
    const ch = pattern[i];
    if (
      ch === "*" &&
      pattern[i + 1] === "*" &&
      (pattern[i + 2] === "/" || pattern[i + 2] === undefined)
    ) {
      // ** — match any number of path segments including zero
      src += "(?:.*/)?";
      i += pattern[i + 2] === "/" ? 3 : 2;
    } else if (ch === "*") {
      src += "[^/]*";
      i++;
    } else if (ch === "?") {
      src += "[^/]";
      i++;
    } else if (ch === "[") {
      // Character class [...]
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        src += "\\[";
        i++;
      } else {
        const cls = pattern.slice(i + 1, close);
        let inner = cls.replace(/!/, "^").replace(/[.+^${}()|\\]/g, "\\$&");
        // Preserve range hyphen: keep literal hyphens at boundaries
        inner = inner.replace(/-]/g, "-]"); // ] after - is fine
        src += `[${inner}]`;
        i = close + 1;
      }
    } else {
      // Escape regex specials
      src += /[.+^${}()|\\]/.test(ch) ? "\\" + ch : ch;
      i++;
    }
  }

  return new RegExp(`^${src}$`);
}

/**
 * Check if a path component matches a glob segment.
 * Splits the glob on `/` and matches sequentially.
 */
function matchGlob(glob: string, filePath: string): boolean {
  const re = globToRegex(glob);
  return re.test(filePath);
}

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
    name === ".c0de"
  );
}

async function walk(
  dir: string,
  base: string,
  depth: number,
  maxDepth: number,
  results: string[],
  limit: number,
): Promise<void> {
  if (depth > maxDepth || results.length >= limit) return;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // Permission denied, doesn't exist, etc.
  }

  for (const entry of entries) {
    if (results.length >= limit) return;
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
      results.push(relPath + "/");
      await walk(fullPath, base, depth + 1, maxDepth, results, limit);
    } else {
      results.push(relPath);
    }
  }
}

// ---------------------------------------------------------------------------
// globTool
// ---------------------------------------------------------------------------

export const globTool: ToolDef = {
  name: "glob",
  description:
    "Search for files matching a glob pattern. Supports ** (recursive), * (single segment), ?, [abc], {a,b} patterns. " +
    "Searches from the session working directory. Skips .git, node_modules, dist, build by default.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern to match filenames (e.g. '**/*.ts', 'src/**/*.{ts,js}', '*.json'). " +
          "Matches relative to the session working directory.",
      },
      maxDepth: {
        type: "integer",
        description: "Maximum directory depth to traverse (default: 20).",
        default: 20,
        minimum: 1,
      },
      limit: {
        type: "integer",
        description: "Maximum number of results to return (default: 100).",
        default: 100,
        minimum: 1,
        maximum: 10000,
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
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    if (pattern.length === 0) {
      return err('glob: "pattern" argument is required');
    }

    const maxDepth =
      typeof args.maxDepth === "number" && args.maxDepth >= 1 ? Math.floor(args.maxDepth) : 20;
    const limit = typeof args.limit === "number" && args.limit >= 1 ? Math.floor(args.limit) : 100;
    const cwdRaw = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : context.cwd;
    const searchDir = resolve(context.cwd, cwdRaw);

    // Collect all files recursively
    const allFiles: string[] = [];
    await walk(searchDir, searchDir, 0, maxDepth, allFiles, limit * 5);

    // Filter by glob pattern (relative paths from searchDir)
    const matched = allFiles.filter((f) => matchGlob(pattern, f));

    // Limit results
    const limited = matched.slice(0, limit);

    if (limited.length === 0) {
      return ok(`(no files matching "${pattern}")`, { pattern, count: 0 });
    }

    const output = limited.join("\n");
    return ok(output, {
      pattern,
      count: limited.length,
      totalMatched: matched.length,
      truncated: matched.length > limit,
    });
  },
};
