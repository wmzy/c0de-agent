// Tool types (§5.2 of the design spec).
//
// Core tool-level types (ToolResult, ToolDef, ToolContext, ToolPermission)
// are defined in ../core/types.ts — the single source of truth. This file
// re-exports them and defines tools-package–specific helpers:
//   - SessionRef, ToolMode, ToolExecutor, ToolRegistry
//
// Conventions:
//   - data + functions only: `type` everywhere, no `interface`, no `class`.
//   - variants are tagged via `_tag` and dispatched via switch on `_tag`.
//   - The ToolRegistry is an opaque nominal type: external code cannot
//     construct one or read its internals without going through the
//     functions in registry.ts. The actual tool map is held behind a
//     module-level WeakMap inside ./registry.ts.

import type {
  ToolContext,
  ToolDef,
  ToolPermission,
  ToolResult,
} from "../core/types";

// ---------------------------------------------------------------------------
// Shared tool-result constructors
// ---------------------------------------------------------------------------

/** Construct a success ToolResult. */
export function ok(output: string, metadata?: Record<string, unknown>): ToolResult {
  return { _tag: "success", output, metadata };
}

/** Construct an error ToolResult. */
export function err(error: string): ToolResult {
  return { _tag: "error", error };
}

/** Construct a permission-required ToolResult. */
export function permissionRequired(reason: string): ToolResult {
  return { _tag: "permission_required", reason };
}

/** Construct a truncated ToolResult. */
export function truncated(output: string, totalLines: number): ToolResult {
  return { _tag: "truncated", output, truncated: true, totalLines };
}

// Re-export canonical tool types from core (single source of truth)
export type { ToolContext, ToolDef, ToolPermission, ToolResult };

// ---------------------------------------------------------------------------
// Session reference — what a tool needs to know about the surrounding
// session to perform its work. Kept intentionally narrow: id + cwd.
// ---------------------------------------------------------------------------

export type SessionRef = {
  id: string;
  cwd: string;
};

// ---------------------------------------------------------------------------
// ToolMode — per-tool mode descriptor (spec §5.2)
// ---------------------------------------------------------------------------

export type ToolMode = {
  name: string;
  description: string;
  isAvailable: (ctx: ToolContext) => boolean;
};

// ---------------------------------------------------------------------------
// ToolExecutor — the function shape tools implement
// ---------------------------------------------------------------------------

export type ToolExecutor = (input: unknown, ctx: ToolContext) => Promise<ToolResult>;

// ---------------------------------------------------------------------------
// ToolRegistry — nominal opaque data type.
//
// The brand is a unique symbol declared in registry.ts and stamped onto the
// object at construction time. Because the symbol is module-private and not
// re-exported from this file, external code cannot create or extend a
// ToolRegistry; only createToolRegistry() can stamp the brand.
//
// The phantom field type is keyed by a generic unique symbol so the type
// definition here stays self-contained. The actual symbol identity used at
// runtime lives behind ./registry.ts.
// ---------------------------------------------------------------------------

declare const ToolRegistryBrand: unique symbol;

export type ToolRegistry = {
  readonly [ToolRegistryBrand]: true;
};
