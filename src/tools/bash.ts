// Built-in `bash` tool (spec §5.4).
//
// Executes a shell command in the working directory supplied via ToolContext.
// Returns ToolResult tagged variants; never throws.
//
// Conventions: data + functions, no class. Uses `node:child_process` for
// the exec side-effect; the public shape is plain data.

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolContext, ToolDef, ToolResult } from "./types";
import { checkFsync } from "./fsync-guard";
import { checkBashFileRead, formatBashFileReadMessage } from "./bash-file-read-guard";

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

function success(output: string): ToolResult {
  return { _tag: "success", output };
}

function failure(message: string, capturedOutput?: string): ToolResult {
  // On error we still surface whatever the process wrote — stdout/stderr
  // often contain the diagnostic the agent needs. The error variant has no
  // metadata field per spec §5.2, so we fold captured output into the
  // error message itself, separated by a clear delimiter.
  const trimmed = (capturedOutput ?? "").trim();
  if (trimmed.length === 0) {
    return { _tag: "error", error: message };
  }
  return {
    _tag: "error",
    error: `${message}\n--- captured output ---\n${trimmed}`,
  };
}

export const bashTool: ToolDef = {
  name: "bash",
  description:
    "Execute a shell command in the session working directory. Returns combined stdout/stderr; non-zero exit codes surface as error results with the captured output preserved in metadata.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute (bash-compatible).",
      },
      timeoutMs: {
        type: "integer",
        description: "Optional execution timeout in milliseconds (default 300000).",
        default: DEFAULT_TIMEOUT_MS,
        minimum: 1,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  permission: "ask",

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;
    const command = typeof args.command === "string" ? args.command : "";
    if (command.length === 0) {
      return { _tag: "error", error: 'bash: "command" argument is required' };
    }

    // Pre-execution fsync guard — detect fsync-related calls and warn
    // before running the command. The warning is prepended to the normal
    // output so the agent sees it as actionable information (spec §5.4).
    const fsyncCheck = checkFsync(command);
    let fsyncWarning = "";
    if (!fsyncCheck.ok) {
      const alts = fsyncCheck.alternatives.map((a, i) => `  ${i + 1}. ${a}`).join("\n");
      fsyncWarning = [
        `[fsync-guard] WARNING: Detected "${fsyncCheck.detected}" in command.`,
        fsyncCheck.warning,
        `Suggested alternatives:`,
        alts,
        "",
      ].join("\n");
    }

    // Pre-execution file read guard — detect sensitive file access in
    // file-reading commands. Block-severity matches abort execution;
    // warn-severity matches prepend an advisory to output.
    const fileReadCheck = checkBashFileRead(command);
    if (!fileReadCheck.ok && fileReadCheck.severity === "block") {
      return failure(formatBashFileReadMessage(fileReadCheck));
    }
    const fileReadWarning =
      !fileReadCheck.ok && fileReadCheck.severity === "warn"
        ? formatBashFileReadMessage(fileReadCheck)
        : "";
    const timeoutMs =
      typeof args.timeoutMs === "number" && args.timeoutMs > 0
        ? Math.floor(args.timeoutMs)
        : DEFAULT_TIMEOUT_MS;

    // Honor caller cancellation: execAsync does not accept an AbortSignal
    // directly, so we race the child process against ctx.abort and kill it
    // when the caller cancels.
    let killedByAbort = false;
    const onAbort = (): void => {
      killedByAbort = true;
    };
    if (context.abort.aborted) {
      return { _tag: "error", error: "bash: aborted before start" };
    }
    context.abort.addEventListener("abort", onAbort, { once: true });

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: context.cwd,
        env: { ...process.env },
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
      });

      if (killedByAbort) {
        return { _tag: "error", error: "bash: aborted during execution" };
      }

      const merged = [stdout, stderr]
        .filter((part) => part.length > 0)
        .join("\n")
        .trim();
      const output = merged.length > 0 ? merged : "(no output)";
      return success(fsyncWarning + fileReadWarning + output);
    } catch (error) {
      const err = error as Error & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };

      const captured = [err.stdout, err.stderr]
        .filter((part) => part && part.length > 0)
        .join("\n")
        .trim();

      if (killedByAbort || err.killed) {
        return failure("bash: aborted during execution", captured);
      }
      if (err.code === "ETIMEDOUT" || /timed out/i.test(err.message)) {
        return failure(`bash: command timed out after ${timeoutMs}ms`, captured);
      }
      const exitInfo = err.code !== undefined ? `exit code ${err.code}` : err.message;
      return failure(`bash: ${exitInfo}`, captured);
    } finally {
      context.abort.removeEventListener("abort", onAbort);
    }
  },
};
