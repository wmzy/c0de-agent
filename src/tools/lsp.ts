// Built-in `lsp` tool (spec §5.4).
//
// Communicates with a language server via JSON-RPC over stdin/stdout.
// Defaults to tsserver for TypeScript/JavaScript files.
//
// Supported actions:
//   - definition     Go-to-definition
//   - references     Find references
//   - hover          Hover info / quickinfo
//   - diagnostics   Semantic diagnostics for a file
//   - symbols        Document symbols (navtree)
//   - rename         Rename symbol
//   - code_actions   Get code actions / fixes
//
// Conventions: data + functions, no class. Uses node:child_process for the
// tsserver subprocess; the public shape is plain data.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import type { ToolContext, ToolDef, ToolResult } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function success(output: string, metadata?: Record<string, unknown>): ToolResult {
  return { _tag: "success", output, ...(metadata ? { metadata } : {}) };
}

function error(message: string): ToolResult {
  return { _tag: "error", error: message };
}

// ---------------------------------------------------------------------------
// tsserver JSON-RPC helpers
// ---------------------------------------------------------------------------

type TsserverRequest = {
  seq: number;
  type: "request";
  command: string;
  arguments?: Record<string, unknown>;
};

/** Convert a 1-based line number to the {line, offset} pair tsserver expects. */
function lineAndOffset(file: string, line: number): { file: string; line: number; offset: number } {
  return { file, line, offset: 1 };
}

/**
 * Spawn tsserver, send one command, return the response body.
 * The server stays alive for the duration of the tool call so multiple
 * operations (e.g. diagnostics after rename) are cheap.
 */
async function tsserverRequest(
  request: TsserverRequest,
  abort: AbortSignal,
  cwd: string,
): Promise<{ success: boolean; body?: unknown; message?: string }> {
  // Spawn tsserver from the project directory.
  const proc = spawn("npx", ["tsserver"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
    signal: abort,
  });

  // Track whether we were aborted to avoid double-kill.
  let procExited = false;
  proc.on("exit", () => {
    procExited = true;
  });

  // The tsserver protocol: each line is a complete JSON message.
  const reader = createInterface({ input: proc.stdout!, crlfDelay: Number.POSITIVE_INFINITY });

  // We need to wait for tsserver's "ready" event before sending.
  const readyPromise = new Promise<void>((resolve, reject) => {
    reader.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "event" && msg.event === "requestCompleted") {
          // Skip intermediate events.
          return;
        }
        // First line is typically the project info or config file diagnostic.
        // We consider the server ready once we see *any* parseable response line.
        // But to keep it simple: after sending the actual request, we collect
        // the response. For now, resolve immediately on first non-event line
        // after a small delay to let initialisation finish.
      } catch {
        // Ignore parse errors (tsserver sometimes outputs non-JSON headers).
      }
    });
    // Give tsserver a moment to start before declaring readiness.
    sleep(500).then(resolve).catch(reject);
  });

  await readyPromise;

  // Send the request.
  const reqJson = JSON.stringify(request) + "\n";
  proc.stdin!.write(reqJson);

  // Collect the response. tsserver may emit events before the response.
  const responsePromise = new Promise<{ success: boolean; body?: unknown; message?: string }>(
    (resolve, reject) => {
      reader.on("line", (line: string) => {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "response" && msg.command === request.command) {
            resolve({
              success: msg.success ?? false,
              body: msg.body,
              message: msg.message,
            });
          }
          // Ignore events (type="event") — they are not the response.
        } catch {
          // Skip lines that aren't JSON.
        }
      });
      reader.on("close", () => {
        if (!procExited) {
          reject(new Error("tsserver stdout closed before response"));
        }
      });
      // Safety timeout.
      abort.addEventListener(
        "abort",
        () => {
          reject(new Error("aborted"));
        },
        { once: true },
      );
    },
  );

  try {
    const result = await responsePromise;
    return result;
  } finally {
    // Clean up the server process.
    if (!procExited) {
      proc.stdin!.end();
      proc.kill();
    }
    reader.close();
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function handleDefinition(
  file: string,
  line: number,
  abort: AbortSignal,
  cwd: string,
): Promise<ToolResult> {
  const result = await tsserverRequest(
    { seq: 1, type: "request", command: "definition", arguments: lineAndOffset(file, line) },
    abort,
    cwd,
  );
  if (!result.success) {
    return error(`lsp definition: ${result.message ?? "no definition found"}`);
  }
  return success(JSON.stringify(result.body, null, 2));
}

async function handleReferences(
  file: string,
  line: number,
  abort: AbortSignal,
  cwd: string,
): Promise<ToolResult> {
  const result = await tsserverRequest(
    { seq: 1, type: "request", command: "references", arguments: lineAndOffset(file, line) },
    abort,
    cwd,
  );
  if (!result.success) {
    return error(`lsp references: ${result.message ?? "no references found"}`);
  }
  return success(JSON.stringify(result.body, null, 2));
}

async function handleHover(
  file: string,
  line: number,
  abort: AbortSignal,
  cwd: string,
): Promise<ToolResult> {
  const result = await tsserverRequest(
    { seq: 1, type: "request", command: "quickinfo", arguments: lineAndOffset(file, line) },
    abort,
    cwd,
  );
  if (!result.success) {
    return error(`lsp hover: ${result.message ?? "no info available"}`);
  }
  return success(JSON.stringify(result.body, null, 2));
}

async function handleDiagnostics(
  file: string,
  abort: AbortSignal,
  cwd: string,
): Promise<ToolResult> {
  const result = await tsserverRequest(
    {
      seq: 1,
      type: "request",
      command: "getDiagnosticsSemantic",
      arguments: { file, includeLinePosition: true },
    },
    abort,
    cwd,
  );
  if (!result.success) {
    return error(`lsp diagnostics: ${result.message ?? "failed to get diagnostics"}`);
  }
  return success(JSON.stringify(result.body, null, 2));
}

async function handleSymbols(file: string, abort: AbortSignal, cwd: string): Promise<ToolResult> {
  const result = await tsserverRequest(
    { seq: 1, type: "request", command: "navtree", arguments: { file } },
    abort,
    cwd,
  );
  if (!result.success) {
    return error(`lsp symbols: ${result.message ?? "no symbols found"}`);
  }
  return success(JSON.stringify(result.body, null, 2));
}

async function handleRename(
  file: string,
  line: number,
  newName: string,
  abort: AbortSignal,
  cwd: string,
): Promise<ToolResult> {
  const result = await tsserverRequest(
    {
      seq: 1,
      type: "request",
      command: "rename",
      arguments: { ...lineAndOffset(file, line), findInComments: false, findInStrings: false },
    },
    abort,
    cwd,
  );
  if (!result.success) {
    return error(`lsp rename: ${result.message ?? "rename not available"}`);
  }

  const renameBody = result.body as
    | { renameLocations?: Array<{ file: string; loc: { line: number; offset: number } }> }
    | undefined;
  if (!renameBody || !renameBody.renameLocations || renameBody.renameLocations.length === 0) {
    return success("(no rename locations found)");
  }

  // Apply the rename: read each file, replace the symbol, write back.
  // For a simple implementation, we use the rename info to tell the caller
  // what locations would change, rather than applying in place.
  return success(
    `Rename "${newName}" would affect ${renameBody.renameLocations.length} location(s):\n` +
      JSON.stringify(renameBody.renameLocations.slice(0, 50), null, 2) +
      (renameBody.renameLocations.length > 50
        ? `\n... and ${renameBody.renameLocations.length - 50} more`
        : ""),
  );
}

async function handleCodeActions(
  file: string,
  line: number,
  query: string | undefined,
  abort: AbortSignal,
  cwd: string,
): Promise<ToolResult> {
  // tsserver uses getCodeFixes with error codes, but we can also try
  // getApplicableRefactors for a broader code-action experience.
  // We attempt both and combine results.

  const errorCodes: number[] = [];
  if (query && /^\d+$/.test(query)) {
    errorCodes.push(Number.parseInt(query, 10));
  }

  const parts: string[] = [];

  // 1) Get code fixes for known error codes.
  if (errorCodes.length > 0) {
    const fixesResult = await tsserverRequest(
      {
        seq: 1,
        type: "request",
        command: "getCodeFixes",
        arguments: {
          file,
          startLine: line,
          startOffset: 1,
          endLine: line,
          endOffset: 1,
          errorCodes,
        },
      },
      abort,
      cwd,
    );
    if (fixesResult.success && fixesResult.body) {
      parts.push(`Code fixes:\n${JSON.stringify(fixesResult.body, null, 2)}`);
    }
  }

  // 2) Get applicable refactors.
  const refactorResult = await tsserverRequest(
    {
      seq: 2,
      type: "request",
      command: "getApplicableRefactors",
      arguments: { file, startLine: line, startOffset: 1, endLine: line, endOffset: 1 },
    },
    abort,
    cwd,
  );
  if (refactorResult.success && refactorResult.body) {
    parts.push(`Refactors:\n${JSON.stringify(refactorResult.body, null, 2)}`);
  }

  if (parts.length === 0) {
    return success("(no code actions available)");
  }
  return success(parts.join("\n\n"));
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const lspTool: ToolDef = {
  name: "lsp",
  description:
    "Perform language-server operations on a file. Supports: definition (go-to-definition), references (find references), hover (type info and docs), diagnostics (semantic errors), symbols (document outline/navigation tree), rename (preview rename locations), code_actions (available code fixes and refactors). Defaults to tsserver for TypeScript/JavaScript.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description:
          "LSP action to perform: 'definition', 'references', 'hover', 'diagnostics', 'symbols', 'rename', 'code_actions'.",
        enum: [
          "definition",
          "references",
          "hover",
          "diagnostics",
          "symbols",
          "rename",
          "code_actions",
        ],
      },
      file: {
        type: "string",
        description: "Path to the target file (relative to session cwd or absolute).",
      },
      line: {
        type: "number",
        description:
          "1-based line number (required for definition, references, hover, rename, code_actions).",
        minimum: 1,
      },
      symbol: {
        type: "string",
        description: "Symbol name (used by some actions that need a symbol rather than file+line).",
      },
      new_name: {
        type: "string",
        description: "New name for rename action.",
      },
      query: {
        type: "string",
        description: "Query string (e.g. error code for code_actions).",
      },
    },
    required: ["action", "file"],
    additionalProperties: false,
  },
  permission: "auto",

  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;
    const action = typeof args.action === "string" ? args.action : "";
    const file = typeof args.file === "string" ? args.file : "";
    const line = typeof args.line === "number" && args.line >= 1 ? Math.floor(args.line) : 1;
    const newName = typeof args.new_name === "string" ? args.new_name : "";
    const query = typeof args.query === "string" ? args.query : undefined;

    if (!action) {
      return error('lsp: "action" argument is required');
    }
    if (!file) {
      return error('lsp: "file" argument is required');
    }

    // Validate action value
    const validActions = [
      "definition",
      "references",
      "hover",
      "diagnostics",
      "symbols",
      "rename",
      "code_actions",
    ];
    if (!validActions.includes(action)) {
      return error(`lsp: unknown action "${action}". Valid actions: ${validActions.join(", ")}`);
    }

    // Guard: file+line needed for position-sensitive actions
    const posActions = ["definition", "references", "hover", "rename", "code_actions"];
    if (posActions.includes(action) && (typeof args.line !== "number" || args.line < 1)) {
      return error(`lsp: "line" argument is required for "${action}" action`);
    }

    // Guard: new_name needed for rename
    if (action === "rename" && !newName) {
      return error('lsp: "new_name" argument is required for rename action');
    }

    try {
      switch (action) {
        case "definition":
          return await handleDefinition(file, line, ctx.abort, ctx.cwd);
        case "references":
          return await handleReferences(file, line, ctx.abort, ctx.cwd);
        case "hover":
          return await handleHover(file, line, ctx.abort, ctx.cwd);
        case "diagnostics":
          return await handleDiagnostics(file, ctx.abort, ctx.cwd);
        case "symbols":
          return await handleSymbols(file, ctx.abort, ctx.cwd);
        case "rename":
          return await handleRename(file, line, newName, ctx.abort, ctx.cwd);
        case "code_actions":
          return await handleCodeActions(file, line, query, ctx.abort, ctx.cwd);
        default:
          return error(`lsp: unhandled action "${action}"`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (ctx.abort.aborted || message === "aborted") {
        return error("lsp: aborted");
      }
      return error(`lsp: ${message}`);
    }
  },
};
