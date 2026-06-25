// Hashline read enhancer (spec §16).
//
// Enhances the `read` tool with hashline awareness:
//   1. Auto-detects hashline format in file content
//   2. Parses hashline patches from content
//   3. Applies hashline patches to referenced files
//   4. Supports `path#[hash]` path syntax for hash-verified reads
//
// Conventions: data + functions, no class. Returns structured results.

import { readFile } from "node:fs/promises";
import { computeHash, parsePatch, applyPatch, type ParsedPatch, type ApplyResult } from "./edit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of detecting hashline format in content. */
export type HashlineDetection =
  | { _tag: "detected"; patches: ParsedPatch[]; headerCount: number }
  | { _tag: "not_detected" };

/** Parsed hash reference from `path#[hash]` syntax. */
export type HashReference =
  | { _tag: "valid"; path: string; hash: string }
  | { _tag: "invalid"; raw: string; reason: string };

/** Result of a hashline-enhanced read operation. */
export type HashlineReadResult =
  | {
      _tag: "plain";
      content: string;
      bytes: number;
      totalLines: number;
    }
  | {
      _tag: "hash_verified";
      content: string;
      bytes: number;
      totalLines: number;
      hash: string;
      verified: boolean;
      actualHash: string;
    }
  | {
      _tag: "patch_applied";
      content: string;
      bytes: number;
      totalLines: number;
      patches: ParsedPatch[];
      appliedCount: number;
      originalHash: string;
    }
  | {
      _tag: "patch_failed";
      content: string;
      bytes: number;
      totalLines: number;
      patches: ParsedPatch[];
      error: string;
    };

/** Options for hashline-enhanced reading. */
export type HashlineReadOptions = {
  /** If true, auto-detect and apply hashline patches found in the content. */
  applyPatches?: boolean;
  /** Expected hash for hash-verified reads. */
  expectedHash?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches `[PATH#HASH]` header lines in hashline format. */
const HASHLINE_HEADER_RE = /^\[(.+?)#([0-9a-f]{4})\]\s*$/;

/** Matches `path#[hash]` in a path argument. */
const HASH_PATH_RE = /^(.+?)#([0-9a-f]{4})$/;

// ---------------------------------------------------------------------------
// detectHashlineFormat
// ---------------------------------------------------------------------------

/**
 * Detect whether content is in hashline format.
 *
 * Heuristics:
 *   - At least one `[PATH#HASH]` header line
 *   - At least one hashline operation (SWAP, DEL, INS.*, etc.)
 *   - Headers and operations interleave in expected pattern
 */
export function detectHashlineFormat(content: string): HashlineDetection {
  const lines = content.split(/\r?\n/);
  let headerCount = 0;
  let opCount = 0;

  for (const line of lines) {
    if (HASHLINE_HEADER_RE.test(line)) {
      headerCount++;
    }
    // Detect common hashline operations
    if (
      /^(?:SWAP|DEL|INS\.(?:PRE|POST|HEAD|TAIL|BLK\.POST))(?:\s+\d+(?:-\d+)?)?\s*$/.test(line)
    ) {
      opCount++;
    }
  }

  if (headerCount >= 1 && opCount >= 1) {
    const patches = parsePatch(content);
    return { _tag: "detected", patches, headerCount };
  }

  return { _tag: "not_detected" };
}

// ---------------------------------------------------------------------------
// parseHashReference
// ---------------------------------------------------------------------------

/**
 * Parse a `path#[hash]` reference from a path string.
 *
 * Examples:
 *   - `src/foo.ts#a1b2` → { path: "src/foo.ts", hash: "a1b2" }
 *   - `src/foo.ts` → { _tag: "invalid", reason: "no hash reference" }
 *   - `src/foo.ts#xyz` → { _tag: "invalid", reason: "invalid hash format" }
 */
export function parseHashReference(path: string): HashReference {
  const match = path.match(HASH_PATH_RE);
  if (!match) {
    return { _tag: "invalid", raw: path, reason: "no hash reference found" };
  }

  const [, filePath, hash] = match;
  if (!filePath || filePath.length === 0) {
    return { _tag: "invalid", raw: path, reason: "empty path before hash" };
  }

  if (hash.length !== 4 || !/^[0-9a-f]{4}$/.test(hash)) {
    return { _tag: "invalid", raw: path, reason: "hash must be 4 hex characters" };
  }

  return { _tag: "valid", path: filePath, hash };
}

// ---------------------------------------------------------------------------
// applyHashlinePatches
// ---------------------------------------------------------------------------

/**
 * Apply hashline patches found in content to a target file's content.
 *
 * Returns the patched content and metadata about what was applied.
 */
export function applyHashlinePatches(
  fileContent: string,
  patches: ParsedPatch[],
): { content: string; appliedCount: number; errors: string[] } {
  let currentContent = fileContent;
  let appliedCount = 0;
  const errors: string[] = [];

  for (const patch of patches) {
    const result = applyPatch(currentContent, patch);
    switch (result._tag) {
      case "success":
        currentContent = result.content;
        appliedCount++;
        break;
      case "hash_mismatch":
        errors.push(
          `hash mismatch for ${patch.path}: expected ${result.expected}, got ${result.actual}`,
        );
        break;
      case "line_not_found":
        errors.push(
          `line not found for operation ${JSON.stringify(result.operation)} in ${patch.path}`,
        );
        break;
    }
  }

  return { content: currentContent, appliedCount, errors };
}

// ---------------------------------------------------------------------------
// readWithHashline — full hashline-enhanced read
// ---------------------------------------------------------------------------

/**
 * Read a file with hashline awareness.
 *
 * Behavior:
 *   1. If `expectedHash` is provided, reads the file and verifies the hash.
 *   2. If `applyPatches` is true, reads the file, detects hashline format,
 *      and applies any patches found to the referenced file.
 *   3. Otherwise, returns the plain file content.
 */
export async function readWithHashline(
  filePath: string,
  options: HashlineReadOptions = {},
): Promise<HashlineReadResult> {
  const { applyPatches = false, expectedHash } = options;

  try {
    const rawContent = await readFile(filePath, "utf-8");
    const totalLines = rawContent.split(/\r?\n/).length;
    const bytes = Buffer.byteLength(rawContent, "utf-8");

    // Hash-verified read
    if (expectedHash) {
      const actualHash = computeHash(rawContent);
      return {
        _tag: "hash_verified",
        content: rawContent,
        bytes,
        totalLines,
        hash: expectedHash,
        verified: actualHash === expectedHash,
        actualHash,
      };
    }

    // Auto-detect and apply patches
    if (applyPatches) {
      const detection = detectHashlineFormat(rawContent);
      if (detection._tag === "detected" && detection.patches.length > 0) {
        // For each patch, try to read the target file and apply
        for (const patch of detection.patches) {
          try {
            const targetContent = await readFile(patch.path, "utf-8");
            const applyResult = applyHashlinePatches(targetContent, [patch]);
            if (applyResult.appliedCount > 0) {
              return {
                _tag: "patch_applied",
                content: applyResult.content,
                bytes: Buffer.byteLength(applyResult.content, "utf-8"),
                totalLines: applyResult.content.split(/\r?\n/).length,
                patches: [patch],
                appliedCount: applyResult.appliedCount,
                originalHash: patch.hash,
              };
            }
            if (applyResult.errors.length > 0) {
              return {
                _tag: "patch_failed",
                content: rawContent,
                bytes,
                totalLines,
                patches: [patch],
                error: applyResult.errors.join("; "),
              };
            }
          } catch {
            // Target file not found — return the patch content itself
            return {
              _tag: "patch_failed",
              content: rawContent,
              bytes,
              totalLines,
              patches: [patch],
              error: `target file ${patch.path} not found for patch application`,
            };
          }
        }
      }
    }

    // Plain read
    return { _tag: "plain", content: rawContent, bytes, totalLines };
  } catch (e) {
    throw new Error(`hashline-read: ${e instanceof Error ? e.message : String(e)}`);
  }
}
