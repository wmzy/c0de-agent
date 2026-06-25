// MCP client (spec §6).
//
// Implements the MCP protocol lifecycle:
//   1. connectMCPServer  — establish transport, perform initialize handshake
//   2. discoverTools     — list tools from the connected server
//   3. callMCPTool       — invoke a tool on the server
//   4. disconnectMCPServer — close the transport
//
// Uses JSON-RPC 2.0 over the abstract MCPTransport layer.
//
// Conventions: data + functions, no class.

import { createTransport } from "./transport";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  MCPContent,
  MCPInitializeParams,
  MCPInitializeResult,
  MCPServerConfig,
  MCPSession,
  MCPTool,
  MCPToolCallResult,
} from "./types";

// MCP protocol version we implement
const MCP_PROTOCOL_VERSION = "2024-11-05";

const CLIENT_INFO = {
  name: "c0de-agent",
  version: "0.1.0",
};

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

let globalRequestId = 0;

function nextId(): number {
  return ++globalRequestId;
}

function makeRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: nextId(),
    method,
    ...(params !== undefined ? { params } : {}),
  };
}

function isSuccessResponse(
  resp: JsonRpcResponse,
): resp is { jsonrpc: "2.0"; id: number | string; result: unknown } {
  return "result" in resp;
}

// ---------------------------------------------------------------------------
// Request/response dispatcher — sends a request, waits for the matching
// response by id, and handles notifications by ignoring them.
// ---------------------------------------------------------------------------

async function sendRequest(session: MCPSession, request: JsonRpcRequest): Promise<unknown> {
  const payload = JSON.stringify(request);
  await session.transport.send(payload);

  // Read responses until we get one matching our request id
  for await (const line of session.transport.receive()) {
    if (!line) continue;

    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch {
      throw new Error(`Invalid JSON-RPC response: ${line}`);
    }

    // Skip notifications (no id field)
    if (!("id" in response) || response.id === null) continue;

    // Check if this response matches our request
    if (response.id !== request.id) continue;

    if (isSuccessResponse(response)) {
      return response.result;
    }
    throw new Error(`JSON-RPC error ${response.error.code}: ${response.error.message}`);
  }

  throw new Error("Transport closed before receiving response");
}

// ---------------------------------------------------------------------------
// connectMCPServer — establish connection and perform initialize handshake
// ---------------------------------------------------------------------------

export async function connectMCPServer(config: MCPServerConfig): Promise<MCPSession> {
  const transport = createTransport(config);

  const session: MCPSession = {
    config,
    transport,
    capabilities: {},
    tools: [],
    nextId: 0,
  };

  // Perform the MCP initialize handshake
  const initParams: MCPInitializeParams = {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  };

  let initResult: unknown;
  try {
    initResult = await sendRequest(
      session,
      makeRequest("initialize", initParams as unknown as Record<string, unknown>),
    );
  } catch (err) {
    transport.close();
    throw new Error(
      `MCP initialize failed for server '${config.name}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = initResult as MCPInitializeResult;
  session.capabilities = result.capabilities ?? {};

  // Send initialized notification (per MCP spec, client sends this after
  // receiving a successful initialize response)
  const notification = {
    jsonrpc: "2.0" as const,
    method: "notifications/initialized",
  };
  await transport.send(JSON.stringify(notification));

  return session;
}

// ---------------------------------------------------------------------------
// discoverTools — list all tools from the connected server
// ---------------------------------------------------------------------------

export async function discoverTools(session: MCPSession): Promise<MCPTool[]> {
  const result = (await sendRequest(session, makeRequest("tools/list"))) as { tools?: MCPTool[] };
  session.tools = result.tools ?? [];
  return session.tools;
}

// ---------------------------------------------------------------------------
// callMCPTool — invoke a tool on the connected server
// ---------------------------------------------------------------------------

export async function callMCPTool(
  session: MCPSession,
  name: string,
  args: unknown,
): Promise<MCPToolCallResult> {
  try {
    const result = await sendRequest(
      session,
      makeRequest("tools/call", {
        name,
        arguments: args as Record<string, unknown>,
      }),
    );
    return result as MCPToolCallResult;
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `MCP tool call failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// disconnectMCPServer — close the transport
// ---------------------------------------------------------------------------

export function disconnectMCPServer(session: MCPSession): void {
  session.transport.close();
}

// ---------------------------------------------------------------------------
// Helpers for extracting results from MCP content
// ---------------------------------------------------------------------------

/**
 * Extract a plain-text representation from MCP tool call content.
 * Concatenates all text content items.
 */
export function extractTextContent(content: MCPContent[]): string {
  const parts: string[] = [];
  for (const item of content) {
    switch (item.type) {
      case "text":
        parts.push(item.text);
        break;
      case "image":
        parts.push(`[image: ${item.mimeType}]`);
        break;
      case "resource":
        parts.push(item.resource.text ?? `[resource: ${item.resource.uri}]`);
        break;
    }
  }
  return parts.join("\n");
}
