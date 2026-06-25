// Built-in `read` and `write` file tools (spec §5.4).
//
// read  — read a UTF-8 text file; permission: 'auto'.
// write — write a UTF-8 text file, creating parent directories; permission: 'ask'.
//
// The names match the spec table at §5.4 (`read`, `write`) rather than the
// earlier `read_file` / `write_file` placeholders, so the LLM sees the
// canonical tool names referenced from the design spec.
//
// Conventions: data + functions, no class. Returns ToolResult variants;
// never throws.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createURLRegistry,
  registerBuiltInResolvers,
  resolveURL,
  type URLRegistry,
  type URLResolveContext,
} from "../core/url-registry";
import {
  detectHashlineFormat,
  parseHashReference,
  type HashlineDetection,
} from "./hashline-read-enhancer";
import { ok, err, type ToolContext, type ToolDef, type ToolResult } from "./types";

// ---------------------------------------------------------------------------
// sliceLines — extract line range from content
// ---------------------------------------------------------------------------

function sliceLines(
  content: string,
  startLine: number | undefined,
  endLine: number | undefined,
): string {
  if (startLine === undefined && endLine === undefined) return content;
  const lines = content.split(/\r?\n/);
  const start = (startLine ?? 1) - 1;
  const end = endLine ?? lines.length;
  return lines.slice(start, end).join("\n");
}

// ---------------------------------------------------------------------------
// URL scheme detection + lazy registry singleton
// ---------------------------------------------------------------------------

/** Match a scheme prefix like `file://`, `skill://`, `agent://`, etc. */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//;

function hasURLScheme(path: string): boolean {
  return SCHEME_RE.test(path);
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
// read
// ---------------------------------------------------------------------------

export const readTool: ToolDef = {
  name: "read",
  description:
    "Read the UTF-8 contents of a file or resolve an internal URL scheme (file://, skill://, agent://, pr://, issue://). Plain paths are resolved relative to the session cwd.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (absolute or relative to cwd) or an internal URL scheme (e.g. file://, skill://, agent://, pr://, issue://).",
      },
      startLine: {
        type: "integer",
        description: "Optional 1-indexed start line (inclusive).",
        minimum: 1,
      },
      endLine: {
        type: "integer",
        description: "Optional 1-indexed end line (inclusive).",
        minimum: 1,
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  permission: "auto",

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;
    const path = typeof args.path === "string" ? args.path : "";
    if (path.length === 0) {
      return err('read: "path" argument is required');
    }

    const startLine =
      typeof args.startLine === "number" && args.startLine >= 1
        ? Math.floor(args.startLine)
        : undefined;
    const endLine =
      typeof args.endLine === "number" && args.endLine >= 1 ? Math.floor(args.endLine) : undefined;
    if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
      return err(`read: endLine (${endLine}) must be >= startLine (${startLine})`);
    }

    // --- Hashline hash reference: path#[hash] syntax ---
    const hashRef = parseHashReference(path);

    // --- URL scheme: dispatch through the URL registry (§3.10) ---
    if (hasURLScheme(hashRef._tag === "valid" ? hashRef.path : path)) {
      try {
        const registry = getURLRegistry();
        const urlCtx: URLResolveContext = { cwd: context.cwd };
        const content = await resolveURL(registry, path, urlCtx);
        return ok(content, { path, bytes: Buffer.byteLength(content, "utf-8") });
      } catch (e) {
        return err(`read: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // --- Plain path: filesystem read with hashline detection ---
    const filePath = hashRef._tag === "valid" ? hashRef.path : path;
    try {
      const full = await readFile(filePath, "utf-8");

      // Hash-verified read: if path had a hash reference, verify it
      if (hashRef._tag === "valid") {
        const { computeHash } = await import("./edit");
        const actualHash = computeHash(full);
        const verified = actualHash === hashRef.hash;
        const content = sliceLines(full, startLine, endLine);
        return ok(content, {
          path: filePath,
          bytes: Buffer.byteLength(content, "utf-8"),
          hashVerified: verified,
          expectedHash: hashRef.hash,
          actualHash,
          ...(startLine !== undefined && endLine !== undefined
            ? { startLine, endLine, totalLines: full.split(/\r?\n/).length }
            : { totalLines: full.split(/\r?\n/).length }),
        });
      }

      // Auto-detect hashline format in content
      const detection: HashlineDetection = detectHashlineFormat(full);
      const metadata: Record<string, unknown> = {
        path: filePath,
        bytes: Buffer.byteLength(full, "utf-8"),
        totalLines: full.split(/\r?\n/).length,
      };

      if (detection._tag === "detected") {
        metadata.hashlineDetected = true;
        metadata.hashlineHeaders = detection.headerCount;
        metadata.hashlinePatches = detection.patches.length;
      }

      if (startLine === undefined && endLine === undefined) {
        return ok(full, metadata);
      }
      const content = sliceLines(full, startLine, endLine);
      return ok(content, {
        ...metadata,
        startLine: startLine!,
        endLine: endLine!,
      });
    } catch (e) {
      return err(`read: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

export const writeTool: ToolDef = {
  name: "write",
  description: "Create or overwrite a UTF-8 text file. Parent directories are created as needed.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The file path to write (absolute or relative to cwd).",
      },
      content: {
        type: "string",
        description: "The UTF-8 content to write to the file.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  permission: "ask",

  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;
    const path = typeof args.path === "string" ? args.path : "";
    const content = typeof args.content === "string" ? args.content : undefined;
    if (path.length === 0) return err('write: "path" argument is required');
    if (content === undefined) return err('write: "content" argument is required');

    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf-8");
      return ok(`Wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${path}`, {
        path,
        bytes: Buffer.byteLength(content, "utf-8"),
      });
    } catch (e) {
      return err(`write: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
