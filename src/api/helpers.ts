// Shared helper functions for API routes.
// Pure data transformations with no module-level state.

import { extname, resolve } from "node:path";
import type { Context } from "hono";
import type { MessageData, SessionData } from "../session";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export function notFound(c: Context, message: string) {
  return c.json({ error: message }, 404);
}

export function badRequest(c: Context, message: string) {
  return c.json({ error: message }, 400);
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/** Safely parse JSON body; returns empty object on failure. */
export async function safeJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/** Parse a query parameter as int, returning `fallback` if absent/NaN. */
export function parseQueryInt(c: Context, key: string, fallback: number): number {
  const raw = c.req.query(key);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Serialize SessionData for JSON response. */
export function serializeSession(s: SessionData): Record<string, unknown> {
  return {
    id: s.id,
    title: s.title,
    parentId: s.parentId ?? null,
    branchPoint: s.branchPoint ?? null,
    metadata: s.metadata ?? {},
    createdAt: s.createdAt instanceof Date ? s.createdAt.toISOString() : s.createdAt,
    updatedAt: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : s.updatedAt,
  };
}

/** Serialize MessageData for JSON response. */
export function serializeMessage(m: MessageData): Record<string, unknown> {
  return {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls ?? null,
    toolCallId: m.toolCallId ?? null,
    createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Path / filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a relative path against the working directory, ensuring the
 * result stays within bounds (no path traversal).
 */
export function safeResolve(base: string, rel: string): string | null {
  const normalizedBase = resolve(base) + "/";
  const abs = resolve(base, rel);
  if (!abs.startsWith(normalizedBase)) return null;
  const segments = abs.split("/");
  if (segments.includes("..")) return null;
  return abs;
}

/** Check if an error is ENOENT (file not found). */
export function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** Map a file extension to a MIME type. Returns octet-stream for unknown. */
export function mimeTypeForExt(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".txt": "text/plain; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
    ".tsx": "text/plain; charset=utf-8",
    ".jsx": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".wasm": "application/wasm",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
  };
  return map[ext] ?? "application/octet-stream";
}
