// MCP tool → ToolDef adapter (spec §6).
//
// Converts an MCPTool (descriptor from tools/list) into an internal ToolDef
// that can be registered in the ToolRegistry. The adapted tool's execute
// function calls the MCP server via the session.
//
// This makes MCP tools transparent to the agent loop — they appear as
// ordinary tools alongside built-in tools.
//
// Conventions: data + functions, no class.

import type { ToolDef, ToolResult } from "../tools/types";
import { callMCPTool, extractTextContent } from "./client";
import type { MCPSession, MCPTool } from "./types";

// ---------------------------------------------------------------------------
// adaptMCPTool — convert a single MCPTool into a ToolDef
// ---------------------------------------------------------------------------

/**
 * Adapt an MCP tool descriptor into an internal ToolDef.
 *
 * The returned ToolDef:
 *   - Uses the MCP tool's name prefixed with the server name:
 *     `${serverName}_${toolName}`
 *   - Carries the MCP tool's description
 *   - Uses the MCP tool's inputSchema as the parameters JSON Schema
 *   - Has permission "auto" (MCP tools are trusted at config time)
 *   - Delegates execution to the MCP server via callMCPTool
 */
export function adaptMCPTool(session: MCPSession, mcpTool: MCPTool): ToolDef {
  const prefixedName = `${session.config.name}_${mcpTool.name}`;

  return {
    name: prefixedName,
    description:
      mcpTool.description ?? `MCP tool '${mcpTool.name}' from server '${session.config.name}'`,
    parameters: mcpTool.inputSchema as ToolDef["parameters"],
    permission: "auto",

    async execute(input: unknown, _ctx): Promise<ToolResult> {
      try {
        const result = await callMCPTool(session, mcpTool.name, input);

        if (result.isError) {
          return {
            _tag: "error",
            error: extractTextContent(result.content),
          };
        }

        return {
          _tag: "success",
          output: extractTextContent(result.content),
        };
      } catch (err) {
        return {
          _tag: "error",
          error: `MCP tool '${mcpTool.name}' execution failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// adaptAllMCPTools — convert all tools in a session
// ---------------------------------------------------------------------------

/**
 * Adapt all discovered MCP tools from a session into ToolDef instances.
 */
export function adaptAllMCPTools(session: MCPSession): ToolDef[] {
  return session.tools.map((tool) => adaptMCPTool(session, tool));
}
