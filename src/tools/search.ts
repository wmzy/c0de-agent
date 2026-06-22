// @c0de/tools - Search tools

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types";

async function* walkDir(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
        continue;
      }
      yield* walkDir(fullPath);
    } else {
      yield fullPath;
    }
  }
}

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search for a pattern in files. Use for finding code, functions, or text across the codebase.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The search pattern (plain text)",
      },
      path: {
        type: "string",
        description: "Directory or file to search in (default: working directory)",
      },
      filePattern: {
        type: "string",
        description: 'File pattern to filter (e.g., "*.ts")',
      },
    },
    required: ["pattern"],
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const pattern = args.pattern as string;
    const searchPath = (args.path as string) || context.workingDirectory;
    const filePattern = args.filePattern as string | undefined;

    const results: string[] = [];
    let fileCount = 0;

    try {
      for await (const filePath of walkDir(searchPath)) {
        if (filePattern && !filePath.match(filePattern.replace(/\*/g, ".*"))) {
          continue;
        }

        try {
          const content = await readFile(filePath, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(pattern)) {
              const relPath = relative(context.workingDirectory, filePath);
              results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
            }
          }

          fileCount++;
        } catch {
          // Skip unreadable files
        }

        if (results.length > 100) {
          results.push("... (truncated, too many matches)");
          break;
        }
      }

      return {
        output:
          results.length > 0
            ? `Found ${results.length} matches in ${fileCount} files:\n\n${results.join("\n")}`
            : `No matches found for "${pattern}"`,
      };
    } catch (error) {
      return {
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

export const listFilesTool: Tool = {
  name: "list_files",
  description: "List files and directories. Use for exploring project structure.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path (default: working directory)",
      },
      maxDepth: {
        type: "number",
        description: "Maximum depth to list (default: 2)",
      },
    },
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const dirPath = (args.path as string) || context.workingDirectory;
    const maxDepth = (args.maxDepth as number) ?? 2;

    async function listDir(dir: string, depth: number, prefix: string): Promise<string[]> {
      if (depth > maxDepth) return [];

      const lines: string[] = [];
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;

        const isDir = entry.isDirectory();
        const icon = isDir ? "📁" : "📄";
        lines.push(`${prefix}${icon} ${entry.name}`);

        if (isDir && depth < maxDepth) {
          const subLines = await listDir(join(dir, entry.name), depth + 1, `${prefix}  `);
          lines.push(...subLines);
        }
      }

      return lines;
    }

    try {
      const lines = await listDir(dirPath, 1, "");
      return { output: lines.join("\n") || "(empty directory)" };
    } catch (error) {
      return {
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
