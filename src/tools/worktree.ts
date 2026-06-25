// Built-in `worktree` tool (spec §5.4).
//
// Manages Git worktrees for isolated development workspaces.
// Delegates to `git worktree` subcommands via child_process.
//
// Supported actions:
//   - create    Create a new worktree at <path> on branch <name>
//   - list      List all worktrees
//   - delete    Remove a worktree at <path>
//   - switch    Checkout <name> in the current worktree
//
// Conventions: data + functions, no class. Uses node:child_process for the
// git subprocess; the public shape is plain data.

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolContext, ToolDef, ToolResult } from "./types";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function success(output: string): ToolResult {
  return { _tag: "success", output };
}

function failure(message: string, capturedOutput?: string): ToolResult {
  const trimmed = (capturedOutput ?? "").trim();
  if (trimmed.length === 0) {
    return { _tag: "error", error: message };
  }
  return {
    _tag: "error",
    error: `${message}\n--- captured output ---\n${trimmed}`,
  };
}

/**
 * Run a git command in the session working directory. Returns stdout on
 * success; surfaces errors with captured stderr.
 */
async function git(args: string[], cwd: string, abort: AbortSignal): Promise<ToolResult> {
  let killedByAbort = false;
  const onAbort = (): void => {
    killedByAbort = true;
  };
  if (abort.aborted) {
    return { _tag: "error", error: "worktree: aborted before start" };
  }
  abort.addEventListener("abort", onAbort, { once: true });

  try {
    const { stdout, stderr } = await execAsync(`git ${args.join(" ")}`, {
      cwd,
      env: { ...process.env },
      timeout: 30_000,
    });

    if (killedByAbort) {
      return { _tag: "error", error: "worktree: aborted" };
    }

    const merged = [stdout, stderr]
      .filter((part) => part.length > 0)
      .join("\n")
      .trim();
    return success(merged.length > 0 ? merged : "(ok)");
  } catch (err) {
    const e = err as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    const captured = [e.stdout, e.stderr]
      .filter((part) => part && part.length > 0)
      .join("\n")
      .trim();

    if (killedByAbort || e.killed) {
      return failure("worktree: aborted", captured);
    }
    const exitInfo = e.code !== undefined ? `exit code ${e.code}` : e.message;
    return failure(`worktree: ${exitInfo}`, captured);
  } finally {
    abort.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

/**
 * Create a new worktree.
 * `git worktree add <path> <branch>`
 */
async function handleCreate(
  name: string | undefined,
  path: string | undefined,
  cwd: string,
  abort: AbortSignal,
): Promise<ToolResult> {
  if (!name) {
    return success(
      'worktree create: "name" argument is required — the branch name to create in the new worktree.',
    );
  }

  // Determine worktree path: if not provided, use "../<name>" by convention.
  const worktreePath = path ?? `../${name}`;

  return await git(["worktree", "add", worktreePath, name], cwd, abort);
}

/**
 * List all worktrees.
 * `git worktree list`
 */
async function handleList(cwd: string, abort: AbortSignal): Promise<ToolResult> {
  return await git(["worktree", "list"], cwd, abort);
}

/**
 * Delete a worktree.
 * `git worktree remove <path>`
 */
async function handleDelete(
  path: string | undefined,
  cwd: string,
  abort: AbortSignal,
): Promise<ToolResult> {
  if (!path) {
    return success(
      'worktree delete: "path" argument is required — the filesystem path of the worktree to remove.',
    );
  }
  return await git(["worktree", "remove", path], cwd, abort);
}

/**
 * Switch to a branch in the current worktree.
 * `git checkout <name>`
 */
async function handleSwitch(
  name: string | undefined,
  cwd: string,
  abort: AbortSignal,
): Promise<ToolResult> {
  if (!name) {
    return success(
      'worktree switch: "name" argument is required — the branch name to switch to in the current worktree.',
    );
  }
  return await git(["checkout", name], cwd, abort);
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const worktreeTool: ToolDef = {
  name: "worktree",
  description:
    "Manage Git worktrees for isolated development workspaces. Supports: create (git worktree add), list (git worktree list), delete (git worktree remove), switch (git checkout to a branch in the current worktree).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Worktree action to perform: 'create', 'list', 'delete', 'switch'.",
        enum: ["create", "list", "delete", "switch"],
      },
      name: {
        type: "string",
        description:
          "Branch name (required for create, switch). For create, this is the new branch to create the worktree on. For switch, the branch to checkout in the current worktree.",
      },
      path: {
        type: "string",
        description:
          "Filesystem path for the worktree (optional for create — defaults to '../<name>'; required for delete).",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  permission: "ask",

  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;
    const action = typeof args.action === "string" ? args.action : "";
    const name = typeof args.name === "string" ? args.name : undefined;
    const path = typeof args.path === "string" ? args.path : undefined;

    if (!action) {
      return failure('worktree: "action" argument is required');
    }

    const validActions = ["create", "list", "delete", "switch"];
    if (!validActions.includes(action)) {
      return failure(
        `worktree: unknown action "${action}". Valid actions: ${validActions.join(", ")}`,
      );
    }

    try {
      switch (action) {
        case "create":
          return await handleCreate(name, path, ctx.cwd, ctx.abort);
        case "list":
          return await handleList(ctx.cwd, ctx.abort);
        case "delete":
          return await handleDelete(path, ctx.cwd, ctx.abort);
        case "switch":
          return await handleSwitch(name, ctx.cwd, ctx.abort);
        default:
          return failure(`worktree: unhandled action "${action}"`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (ctx.abort.aborted) {
        return failure("worktree: aborted");
      }
      return failure(`worktree: ${message}`);
    }
  },
};
