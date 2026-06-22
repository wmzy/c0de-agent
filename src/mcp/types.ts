// @c0de/mcp - MCP protocol types

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPResource {
  uri: string;
  name: string;
  mimeType?: string;
}

export interface MCPClient {
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  listResources?(): Promise<MCPResource[]>;
  readResource?(uri: string): Promise<string>;
  close(): Promise<void>;
}
