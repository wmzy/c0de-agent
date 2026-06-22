// @c0de/tools - Bash tool

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext, ToolResult } from "./types";

const execAsync = promisify(exec);

export const bashTool: Tool = {
  name: "bash",
  description:
    "Execute a bash command. Use for running scripts, git operations, building, testing, and any terminal operations.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The bash command to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default: 30)",
      },
    },
    required: ["command"],
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const command = args.command as string;
    const timeout = ((args.timeout as number) ?? 30) * 1000;

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: context.workingDirectory,
        env: { ...process.env, ...context.env },
        timeout,
        maxBuffer: 1024 * 1024 * 10, // 10MB
      });

      const output = [stdout, stderr].filter(Boolean).join("\n").trim();

      return {
        output: output || "(no output)",
      };
    } catch (error) {
      const err = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      if (err.code !== undefined) {
        return {
          output: [err.stdout, err.stderr].filter(Boolean).join("\n").trim() || "(no output)",
          error: `Exit code: ${err.code}`,
        };
      }

      return {
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
