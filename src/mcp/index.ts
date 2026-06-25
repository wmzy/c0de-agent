// MCP package public API (spec §6).
//
// Re-exports types and functions for the MCP protocol client.
// The MCP package provides:
//   - Transport layer (stdio, SSE)
//   - Client lifecycle (connect, discover, call, disconnect)
//   - Tool adapter (MCPTool → ToolDef)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  JsonRpcError,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  MCPCapabilities,
  MCPContent,
  MCPInitializeParams,
  MCPInitializeResult,
  MCPResult,
  MCPResultErr,
  MCPResultOk,
  MCPServerConfig,
  MCPServerInfo,
  MCPSession,
  MCPTool,
  MCPToolCallResult,
  MCPToolInputSchema,
  MCPTransport,
} from "./types";

export { JSONRPC_ERROR_CODES } from "./types";

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export {
  createStdioTransport,
  createSSETransport,
  createTransport,
} from "./transport";

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export {
  connectMCPServer,
  disconnectMCPServer,
  discoverTools,
  callMCPTool,
  extractTextContent,
} from "./client";

// ---------------------------------------------------------------------------
// Tool adapter
// ---------------------------------------------------------------------------

export { adaptMCPTool, adaptAllMCPTools } from "./tool-adapter";
