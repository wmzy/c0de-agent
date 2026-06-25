// File routes (§9.2).
//
// GET /api/files/search-content — search file contents by keyword
// GET /api/files/search        — search for files by name pattern
// GET /api/files               — browse a directory
// GET /api/files/*/raw         — raw file content for preview/download
// GET /api/files/*             — read a file's content
// PUT /api/files/*             — write a file

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Hono } from "hono";
import {
  badRequest,
  isEnoent,
  mimeTypeForExt,
  notFound,
  parseQueryInt,
  safeJson,
  safeResolve,
} from "../helpers";
import type { ServerDeps } from "../index";

// ---------------------------------------------------------------------------
// File-specific helpers
// ---------------------------------------------------------------------------

/**
 * Recursively search for files whose name contains the query string.
 * Collects up to `maxResults` matches. Skips hidden dirs and node_modules.
 */
async function searchFiles(
  dir: string,
  query: string,
  results: Array<{ path: string; name: string; size: number; isDir: boolean }>,
  maxResults: number,
  rootDir: string,
): Promise<void> {
  if (results.length >= maxResults) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxResults) return;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(rootDir, fullPath);

    if (entry.name.toLowerCase().includes(query)) {
      try {
        const s = await stat(fullPath);
        results.push({
          path: relPath,
          name: entry.name,
          size: s.size,
          isDir: entry.isDirectory(),
        });
      } catch {
        results.push({
          path: relPath,
          name: entry.name,
          size: 0,
          isDir: entry.isDirectory(),
        });
      }
    }

    if (entry.isDirectory()) {
      await searchFiles(fullPath, query, results, maxResults, rootDir);
    }
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerFileRoutes(app: Hono, deps: ServerDeps): void {
  // GET /api/files/search-content — search file contents by keyword.
  // Must be registered BEFORE /api/files/:path to avoid route conflict.
  app.get("/api/files/search-content", async (c) => {
    const query = c.req.query("q");
    if (!query) return badRequest(c, "q query parameter is required");
    const q: string = query.toLowerCase();

    const maxResults = parseQueryInt(c, "limit", 50);
    const rootDir = deps.workingDirectory;
    const results: Array<{
      path: string;
      name: string;
      line: number;
      content: string;
    }> = [];

    // Recursive content search — reads files and matches lines.
    const skipDirs = new Set([".git", "node_modules", ".next", "dist", "build", "target", ".c0de"]);
    async function searchDir(dir: string, depth: number): Promise<void> {
      if (depth > 15 || results.length >= maxResults) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (results.length >= maxResults) break;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") || skipDirs.has(entry.name)) continue;
          await searchDir(fullPath, depth + 1);
        } else if (entry.isFile()) {
          let content: string;
          try {
            const buf = await readFile(fullPath);
            // Skip binary files and empty files
            if (buf.length === 0 || buf.length > 512_000) continue;
            const sample = buf.subarray(0, 512);
            if (Buffer.alloc(512).some((b, i) => i < sample.length && sample[i] === 0)) continue;
            content = buf.toString("utf-8");
          } catch {
            continue;
          }

          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            if (lines[i].toLowerCase().includes(q)) {
              results.push({
                path: relative(rootDir, fullPath),
                name: entry.name,
                line: i + 1,
                content: lines[i].trim(),
              });
            }
          }
        }
      }
    }

    await searchDir(rootDir, 0);
    return c.json(results);
  });

  // GET /api/files/search — search for files by name pattern.
  // Must be registered BEFORE /api/files/:path to avoid route conflict.
  app.get("/api/files/search", async (c) => {
    const query = c.req.query("q");
    if (!query) return badRequest(c, "q query parameter is required");

    const results: Array<{ path: string; name: string; size: number; isDir: boolean }> = [];
    const maxResults = parseQueryInt(c, "limit", 50);
    await searchFiles(
      deps.workingDirectory,
      query.toLowerCase(),
      results,
      maxResults,
      deps.workingDirectory,
    );
    return c.json(results);
  });

  // GET /api/files — browse a directory (default: working directory root).
  app.get("/api/files", async (c) => {
    const relPath = c.req.query("path") ?? "";
    const absPath = safeResolve(deps.workingDirectory, relPath);
    if (!absPath) return badRequest(c, "Invalid path");

    try {
      const entries = await readdir(absPath, { withFileTypes: true });
      const items = await Promise.all(
        entries
          .filter((e) => !e.name.startsWith("."))
          .sort((a, b) => {
            // Directories first, then alphabetical.
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name);
          })
          .map(async (entry) => {
            const fullPath = join(absPath, entry.name);
            const relToRoot = relative(deps.workingDirectory, fullPath);
            try {
              const s = await stat(fullPath);
              return {
                name: entry.name,
                path: relToRoot,
                isDir: entry.isDirectory(),
                size: s.size,
                modified: s.mtime.toISOString(),
              };
            } catch {
              return {
                name: entry.name,
                path: relToRoot,
                isDir: entry.isDirectory(),
                size: 0,
                modified: null,
              };
            }
          }),
      );
      return c.json({ path: relPath, entries: items });
    } catch (err) {
      if (isEnoent(err)) return notFound(c, `Directory not found: ${relPath}`);
      throw err;
    }
  });

  // GET /api/files/*/raw — raw file content for preview/download.
  // Registered BEFORE the general /api/files/* to avoid route shadowing.
  app.get("/api/files/*/raw", async (c) => {
    // Hono wildcard captures everything after /api/files/ and before /raw
    const fullPath = c.req.path.replace(/^\/api\/files\//, "");
    const relPath = fullPath.replace(/\/raw$/, "");
    if (!relPath) return badRequest(c, "File path is required");

    const absPath = safeResolve(deps.workingDirectory, relPath);
    if (!absPath) return badRequest(c, "Invalid path");

    try {
      const content = await readFile(absPath);
      const contentType = mimeTypeForExt(absPath);
      return new Response(content, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      if (isEnoent(err)) return notFound(c, `File not found: ${relPath}`);
      throw err;
    }
  });

  // GET /api/files/:path — read a file's content.
  app.get("/api/files/*", async (c) => {
    // Hono wildcard captures everything after /api/files/
    const relPath = c.req.path.replace(/^\/api\/files\//, "");
    if (!relPath) return badRequest(c, "File path is required");

    const absPath = safeResolve(deps.workingDirectory, relPath);
    if (!absPath) return badRequest(c, "Invalid path");

    try {
      const content = await readFile(absPath, "utf-8");
      const s = await stat(absPath);
      return c.json({
        path: relPath,
        content,
        size: s.size,
        modified: s.mtime.toISOString(),
      });
    } catch (err) {
      if (isEnoent(err)) return notFound(c, `File not found: ${relPath}`);
      throw err;
    }
  });

  // PUT /api/files/:path — write a file.
  app.put("/api/files/*", async (c) => {
    const relPath = c.req.path.replace(/^\/api\/files\//, "");
    if (!relPath) return badRequest(c, "File path is required");

    const absPath = safeResolve(deps.workingDirectory, relPath);
    if (!absPath) return badRequest(c, "Invalid path");

    const body = await safeJson(c);
    if (!body?.content || typeof body.content !== "string") {
      return badRequest(c, "content is required and must be a string");
    }

    // Ensure parent directory exists.
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, body.content, "utf-8");
    const s = await stat(absPath);

    return c.json({
      path: relPath,
      size: s.size,
      modified: s.mtime.toISOString(),
      written: true,
    });
  });
}
