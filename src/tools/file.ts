// @c0de/tools - File read/write tools

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types";

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file. Use for examining code, configs, or any text file.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The file path to read (relative to working directory)",
      },
    },
    required: ["path"],
  },

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const path = args.path as string;

    try {
      const content = await readFile(path, "utf-8");
      return { output: content };
    } catch (error) {
      return {
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Write content to a file. Creates parent directories if needed. Use for creating or modifying files.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The file path to write (relative to working directory)",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["path", "content"],
  },

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const path = args.path as string;
    const content = args.content as string;

    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf-8");
      return { output: `File written: ${path}` };
    } catch (error) {
      return {
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
