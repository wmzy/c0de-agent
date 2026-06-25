// MCP protocol types (spec §6).
//
// Defines the wire-level types for the Model Context Protocol (MCP) built on
// JSON-RPC 2.0, plus session and tool descriptors for the internal layer.
//
// Conventions:
//   - data + functions only: `type` everywhere, no `interface`, no `class`.
//   - variants are tagged via `_tag` and dispatched via switch on `_tag`.
//   - MCP transport types are structural (no brand/phantom fields).

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 primitives
// ---------------------------------------------------------------------------

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number | string; result: unknown }
  | { jsonrpc: "2.0"; id: number | string | null; error: JsonRpcError };

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
};

// Standard JSON-RPC error codes
export const JSONRPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ---------------------------------------------------------------------------
// MCP transport abstraction
// ---------------------------------------------------------------------------

export type MCPTransport = {
  send(message: string): Promise<void>;
  receive(): AsyncIterable<string>;
  close(): void;
};

// ---------------------------------------------------------------------------
// MCP server configuration — matches the canonical type from core/types.ts
// so downstream code only imports from this package.
// ---------------------------------------------------------------------------

export type MCPServerConfig = {
  name: string;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// MCP session — the live connection to a single MCP server
// ---------------------------------------------------------------------------

export type MCPSession = {
  config: MCPServerConfig;
  transport: MCPTransport;
  capabilities: MCPCapabilities;
  tools: MCPTool[];
  nextId: number;
};

// ---------------------------------------------------------------------------
// MCP capabilities (returned during initialize handshake)
// ---------------------------------------------------------------------------

export type MCPCapabilities = {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// MCP server info (returned during initialize)
// ---------------------------------------------------------------------------

export type MCPServerInfo = {
  name: string;
  version: string;
};

// ---------------------------------------------------------------------------
// MCP tool — descriptor returned by tools/list
// ---------------------------------------------------------------------------

export type MCPTool = {
  name: string;
  description?: string;
  inputSchema: MCPToolInputSchema;
};

// MCP tool input schema is a JSON Schema object (typically type: "object")
export type MCPToolInputSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// MCP tool call / result (tools/call wire types)
// ---------------------------------------------------------------------------

export type MCPToolCallResult = {
  content: MCPContent[];
  isError?: boolean;
};

export type MCPContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource";
      resource: { uri: string; text?: string; mimeType?: string };
    };

// ---------------------------------------------------------------------------
// MCP initialize request/response
// ---------------------------------------------------------------------------

export type MCPInitializeParams = {
  protocolVersion: string;
  capabilities: MCPCapabilities;
  clientInfo: { name: string; version: string };
};

export type MCPInitializeResult = {
  protocolVersion: string;
  capabilities: MCPCapabilities;
  serverInfo: MCPServerInfo;
};

// ---------------------------------------------------------------------------
// Internal result type for MCP operations
// ---------------------------------------------------------------------------

export type MCPResultOk<T> = { ok: true; value: T };
export type MCPResultErr = { ok: false; error: string };
export type MCPResult<T> = MCPResultOk<T> | MCPResultErr;
