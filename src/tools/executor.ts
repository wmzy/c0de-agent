// Tool executor (spec §5.3).
//
// Implements the orchestration pipeline that turns an LLM-emitted tool call
// into a ToolResult:
//
//   1. Look up the tool by name in the registry.
//   2. Coerce the LLM's raw `input` into an object (the spec lets each tool
//      author decide on full JSON-Schema validation; we do a minimal
//      shape check so common LLM bugs surface early with a clean error).
//   3. Enforce the permission policy:
//        - 'deny'  → return { _tag: 'permission_required', reason }
//        - 'ask'   → return { _tag: 'permission_required', reason }
//        - 'auto'  → continue
//      (Both 'deny' and 'ask' produce a permission_required result; the
//      agent loop distinguishes them by `reason`.)
//   4. Invoke the tool's execute function with ToolContext.
//   5. Catch and normalize any thrown error into { _tag: 'error' }.
//
// Public API:
//   - executeTool(registry, name, input, ctx): Promise<ToolResult>
//
// Conventions: data + functions, no class. ToolResult uses `_tag` dispatch.

import { recoverToolInput, formatRecoverySummary } from "./json-recovery";
import { getTool } from "./registry";
import {
  extractFilePaths,
  createRevertStore,
  isRevertable,
  type SessionRevertStore,
} from "./revert";
import type { ToolContext, ToolPermission, ToolRegistry, ToolResult } from "./types";

// ---------------------------------------------------------------------------
// Permission Checker (spec §2.5)
// ---------------------------------------------------------------------------

/**
 * PermissionChecker — data + functions, no class.
 *
 * `check` inspects a tool's declared permission and returns:
 *   - `{ status: 'allow' }`  for auto-approved tools
 *   - `{ status: 'deny', reason }` for always-denied tools
 *   - `{ status: 'ask', toolCallId, approved }` for tools that need user
 *     confirmation. The `approved` promise resolves when `confirm` is called.
 *
 * `confirm(toolCallId, approved)` resolves the pending promise for the
 * matching ask, unblocking the executor.
 */

export type PermissionCheckResult =
  | { status: "allow" }
  | { status: "deny"; reason: string }
  | { status: "ask"; toolCallId: string; approved: Promise<boolean> };

export type PermissionChecker = {
  check: (toolName: string, permission: ToolPermission, input: unknown) => PermissionCheckResult;
  confirm: (toolCallId: string, approved: boolean) => void;
};

export type PermissionCheckerConfig = {
  /** Always-deny tools regardless of their declared permission. */
  denyList?: string[];
  /** Always-auto-approve tools regardless of their declared permission. */
  allowList?: string[];
};

/**
 * Factory: create a PermissionChecker bound to an optional allow/deny
 * configuration. The denyList takes precedence over allowList.
 */
export function createPermissionChecker(config: PermissionCheckerConfig = {}): PermissionChecker {
  const pending = new Map<string, { resolve: (value: boolean) => void }>();
  const denySet = new Set(config.denyList ?? []);
  const allowSet = new Set(config.allowList ?? []);

  function check(
    toolName: string,
    permission: ToolPermission,
    _input: unknown,
  ): PermissionCheckResult {
    // Hard deny list overrides tool-declared permission.
    if (denySet.has(toolName)) {
      return { status: "deny", reason: `Tool "${toolName}" is in the deny list` };
    }

    // Hard allow list overrides tool-declared permission.
    if (allowSet.has(toolName)) {
      return { status: "allow" };
    }

    switch (permission) {
      case "auto":
        return { status: "allow" };
      case "deny":
        return { status: "deny", reason: `Tool "${toolName}" has deny policy` };
      case "ask": {
        const toolCallId = `perm-${crypto.randomUUID()}`;
        const approved = new Promise<boolean>((resolve) => {
          pending.set(toolCallId, { resolve });
        });
        return { status: "ask", toolCallId, approved };
      }
    }
  }

  function confirm(toolCallId: string, approved: boolean): void {
    const entry = pending.get(toolCallId);
    if (entry) {
      entry.resolve(approved);
      pending.delete(toolCallId);
    }
  }

  return { check, confirm };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Coerce the LLM-supplied `input` (always typed as `unknown`) into a plain
 * object we can pass to the tool. Most providers serialize tool arguments
 * as a JSON-encoded string; a few hand us a pre-parsed object. We accept
 * both shapes and normalize to `Record<string, unknown>`.
 *
 * If the input cannot be coerced to an object we return an error ToolResult
 * that the caller can surface verbatim.
 */
function coerceInput(
  name: string,
  raw: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; result: ToolResult } {
  if (raw === null || raw === undefined) {
    return { ok: true, value: {} };
  }

  if (typeof raw === "object") {
    return { ok: true, value: raw as Record<string, unknown> };
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return { ok: true, value: {} };
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, value: parsed as Record<string, unknown> };
      }
      return {
        ok: false,
        result: {
          _tag: "error",
          error: `Tool "${name}" expects a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
        },
      };
    } catch (err) {
      // Attempt JSON recovery for common LLM errors (trailing commas,
      // unquoted keys, markdown fences, etc.)
      const recovery = recoverToolInput(trimmed);
      if (recovery._tag === "recovered" && recovery.fixes.length > 0) {
        const value = recovery.value;
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          return { ok: true, value: value as Record<string, unknown> };
        }
      }
      const detail =
        recovery._tag === "recovered" && recovery.fixes.length > 0
          ? ` (recovered ${formatRecoverySummary(recovery)})`
          : "";
      return {
        ok: false,
        result: {
          _tag: "error",
          error: `Tool "${name}" received invalid JSON arguments: ${err instanceof Error ? err.message : String(err)}${detail}`,
        },
      };
    }
  }

  return {
    ok: false,
    result: {
      _tag: "error",
      error: `Tool "${name}" expects an object or JSON string, got ${typeof raw}`,
    },
  };
}

/**
 * Build a permission_required result for the given tool, with a reason that
 * names the tool and the policy that was applied.
 */
function permissionRequired(name: string, permission: "ask" | "deny"): ToolResult {
  return {
    _tag: "permission_required",
    reason: `Tool "${name}" requires ${permission === "deny" ? "denial (deny policy)" : "explicit user approval (ask policy)"}`,
  };
}

// ---------------------------------------------------------------------------
// Output truncation (spec §2.6)
// ---------------------------------------------------------------------------

export type TruncateOptions = {
  /** Maximum number of lines before truncation kicks in. */
  maxLines: number;
  /** Maximum character count before truncation kicks in. */
  maxChars: number;
  /** Number of lines to keep from the start when truncating. */
  headLines: number;
  /** Number of lines to keep from the end when truncating. */
  tailLines: number;
};

export const DEFAULT_TRUNCATE_OPTIONS: TruncateOptions = {
  maxLines: 2000,
  maxChars: 100_000,
  headLines: 50,
  tailLines: 50,
};

/**
 * Return type for the pure `truncateOutput` function.
 */
export type TruncateOutput = {
  /** The (possibly truncated) output string. */
  output: string;
  /** Whether truncation was applied. */
  truncated: boolean;
  /** Total line count of the original input. */
  totalLines: number;
  /** Total character count of the original input. */
  totalChars: number;
};

/**
 * Pure function: truncate a raw string according to the given options.
 *
 * Two truncation strategies, applied in priority order:
 *  1. **Line truncation** — when line count exceeds `maxLines`, keep
 *     `headLines` from the top and `tailLines` from the bottom; replace the
 *     middle with a marker like `[... truncated N of M lines (C chars) ...]`.
 *  2. **Character truncation** — when char count exceeds `maxChars` but line
 *     count is within budget, slice at clean newline boundaries near the
 *     char limit; insert a marker like
 *     `[... truncated C chars to fit L char limit ...]`.
 *
 * When both limits are exceeded, line truncation wins because it preserves
 * structural integrity (code blocks, log sections) better than a raw char
 * slice.
 */
export function truncateOutput(text: string, opts?: Partial<TruncateOptions>): TruncateOutput {
  const o: TruncateOptions = { ...DEFAULT_TRUNCATE_OPTIONS, ...opts };
  const totalChars = text.length;
  const lines = text.split("\n");
  const totalLines = lines.length;

  const needsLineTruncation = totalLines > o.maxLines;
  const needsCharTruncation = totalChars > o.maxChars;

  if (!needsLineTruncation && !needsCharTruncation) {
    return { output: text, truncated: false, totalLines, totalChars };
  }

  // Line-based truncation — preferred when both limits are breached.
  if (needsLineTruncation) {
    const head = lines.slice(0, o.headLines);
    const tail = lines.slice(-o.tailLines);
    const dropped = totalLines - o.headLines - o.tailLines;
    const output = [
      ...head,
      `\n[... truncated ${dropped} of ${totalLines} lines (${totalChars.toLocaleString()} chars) ...]\n`,
      ...tail,
    ].join("\n");
    return { output, truncated: true, totalLines, totalChars };
  }

  // Character-only truncation — find clean line boundaries near the limits.
  const headEnd = findLineBoundary(text, o.maxChars, "forward");
  const tailStart = findLineBoundary(text, o.maxChars, "backward");
  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);
  const output = [
    head,
    `\n[... truncated ${totalChars.toLocaleString()} chars to fit ${o.maxChars.toLocaleString()} char limit ...]\n`,
    tail,
  ].join("");
  return { output, truncated: true, totalLines, totalChars };
}

/**
 * Truncate a success ToolResult's output if it exceeds the configured
 * thresholds. Non-success results pass through unchanged.
 *
 * When truncation is needed the result is returned as `_tag: 'truncated'`
 * (spec §5.2 ToolResult variant) with the structured output from
 * `truncateOutput`.
 */
export function truncateResult(result: ToolResult, opts?: Partial<TruncateOptions>): ToolResult {
  if (result._tag !== "success") return result;

  const { output, truncated, totalLines } = truncateOutput(result.output, opts);
  if (!truncated) return result;

  return {
    _tag: "truncated",
    output,
    truncated: true,
    totalLines,
  };
}

/**
 * Find a clean line boundary (newline position) near the character limit.
 * Direction 'forward' scans from the start; 'backward' scans from the end.
 */
function findLineBoundary(
  text: string,
  charLimit: number,
  direction: "forward" | "backward",
): number {
  if (direction === "forward") {
    // Find the last newline before charLimit
    const idx = text.lastIndexOf("\n", charLimit);
    return idx === -1 ? charLimit : idx + 1;
  }
  // backward: find the first newline after (length - charLimit)
  const start = Math.max(0, text.length - charLimit);
  const idx = text.indexOf("\n", start);
  return idx === -1 ? start : idx;
}

// ---------------------------------------------------------------------------
// executeTool — public entry point
// ---------------------------------------------------------------------------

/**
 * Options for executeTool. Extends the base parameters with optional
 * session-level revert store for cross-tool-call atomic rollback.
 */
export type ExecuteToolOptions = {
  registry: ToolRegistry;
  name: string;
  input: unknown;
  ctx: ToolContext;
  truncateOpts?: Partial<TruncateOptions>;
  /**
   * Optional session-level revert store. When provided, file snapshots are
   * accumulated across tool calls so the agent can perform session-level
   * rollback on error.
   */
  sessionRevertStore?: SessionRevertStore;
  /** Call id for session store tracking (e.g. tool call id from LLM). */
  callId?: string;
};

export async function executeTool(
  registry: ToolRegistry,
  name: string,
  input: unknown,
  ctx: ToolContext,
  truncateOpts?: Partial<TruncateOptions>,
  sessionRevertStore?: SessionRevertStore,
  callId?: string,
): Promise<ToolResult> {
  // Honor cancellation as early as possible. Tools that long-poll inside
  // their own body should also check ctx.abort, but we fail fast at the
  // framework boundary so callers see a consistent error.
  if (ctx.abort.aborted) {
    return {
      _tag: "error",
      error: `Tool "${name}" execution aborted before start`,
    };
  }

  // Step 1 — look up the tool definition.
  const tool = getTool(registry, name);
  if (!tool) {
    return {
      _tag: "error",
      error: `Unknown tool: "${name}"`,
    };
  }

  // Step 2 — validate / coerce input shape.
  const coerced = coerceInput(name, input);
  if (!coerced.ok) {
    return coerced.result;
  }

  // Step 3 — permission check.
  switch (tool.permission) {
    case "deny":
      return permissionRequired(name, "deny");
    case "ask":
      return permissionRequired(name, "ask");
    case "auto":
      break;
  }

  // Step 4 — snapshot files before execution (revert mechanism).
  // For revertable tools (write/edit), save file content before modification
  // so we can restore on failure. Non-revertable tools skip this.
  // When a sessionRevertStore is provided, snapshots accumulate across tool
  // calls for session-level atomic rollback.
  const needsRevert = isRevertable(name);
  const revertStore = needsRevert ? createRevertStore() : null;
  if (revertStore) {
    const paths = extractFilePaths(name, coerced.value);
    for (const p of paths) {
      await revertStore.save(p);
      // Also record in session store when provided
      if (sessionRevertStore) {
        await sessionRevertStore.snapshot(p, name, callId);
      }
    }
  }

  // Step 5 + 6 — execute and catch thrown errors, normalizing them into the
  // _tag: 'error' variant. A well-behaved tool returns ToolResult directly;
  // a misbehaving one (throw) still yields a clean error to the agent loop.
  let result: ToolResult;
  try {
    result = await tool.execute(coerced.value, ctx);
  } catch (err) {
    result = {
      _tag: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Step 7 — revert on failure for file-modifying tools.
  // If the tool returned an error (or threw), restore original file state.
  // The session store keeps snapshots for session-level rollback.
  if (revertStore && result._tag === "error") {
    await revertStore.rollback();
  } else if (revertStore) {
    revertStore.commit();
    if (sessionRevertStore) {
      sessionRevertStore.commit(name, callId);
    }
  }

  // Step 8 — auto-truncate large outputs (spec §2.6).
  return truncateResult(result, truncateOpts);
}
