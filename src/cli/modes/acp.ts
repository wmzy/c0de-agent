// ACP mode — Agent Client Protocol (design spec §11.2).
//
// JSON-RPC 2.0 over stdin/stdout for editor integration (VS Code, Neovim, etc.).
// Runs as a persistent process, reading JSON-RPC requests from stdin and
// writing responses + event notifications to stdout.
//
// Supported methods:
//   chat             — send a message to the agent, stream events
//   tool/confirm     — approve/deny a pending tool call
//   session/list     — list active sessions
//   session/create   — create a new session
//   abort            — abort the current agent execution
//
// Data + functions: no class, no this, no enum.

import * as readline from "node:readline/promises";
import type { AgentConfig, AgentEvent, AgentState, Message } from "../../agent";
import { abortAgent, createAgent, runAgent } from "../../agent";
import type { Config } from "../../core/types";
import { createProviderRegistry } from "../../llm";
import { createDefaultRegistry } from "../../tools";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

type JSONRPCID = string | number | null;

type JSONRPCRequestMessage = {
  jsonrpc: "2.0";
  id: JSONRPCID;
  method: string;
  params: unknown;
};

type ACPRequestParams =
  | { method: "chat"; params: { message: string; sessionId?: string } }
  | { method: "tool/confirm"; params: { toolCallId: string; approved: boolean } }
  | { method: "session/list"; params: Record<string, never> }
  | { method: "session/create"; params: { title?: string } }
  | { method: "abort"; params: Record<string, never> };

type JSONRPCResponseMessage = {
  jsonrpc: "2.0";
  id: JSONRPCID;
} & (
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string; data?: unknown } }
);

type JSONRPCNotificationMessage = {
  jsonrpc: "2.0";
  method: "event";
  params: AgentEvent;
};

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

const JSONRPC_VERSION = "2.0" as const;

function jsonRpcResult(id: JSONRPCID, result: Record<string, unknown>): JSONRPCResponseMessage {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function jsonRpcError(id: JSONRPCID, code: number, message: string): JSONRPCResponseMessage {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

function jsonRpcEvent(event: AgentEvent): JSONRPCNotificationMessage {
  return { jsonrpc: JSONRPC_VERSION, method: "event", params: event };
}

function writeMessage(msg: JSONRPCResponseMessage | JSONRPCNotificationMessage): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// ---------------------------------------------------------------------------
// JSON-RPC error codes (standard + custom)
// ---------------------------------------------------------------------------

const ERROR_PARSE = -32700;
const ERROR_INVALID_REQUEST = -32600;
const ERROR_METHOD_NOT_FOUND = -32601;
const ERROR_INTERNAL = -32603;

// ---------------------------------------------------------------------------
// Pending tool confirmation tracking
//
// When the agent yields a `permission_required` event, the ACP mode sends it
// as an event notification and records a pending confirmation. The editor
// responds with `tool/confirm` to approve or deny, and we resolve the
// deferred promise to let the agent proceed.
// ---------------------------------------------------------------------------

type PendingConfirmation = {
  toolCallId: string;
  tool: string;
  input: unknown;
  resolve: (approved: boolean) => void;
};

type PendingConfirmations = Map<string, PendingConfirmation>;

function createPendingConfirmations(): PendingConfirmations {
  return new Map();
}

function addPendingConfirmation(
  map: PendingConfirmations,
  toolCallId: string,
  tool: string,
  input: unknown,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    map.set(toolCallId, { toolCallId, tool, input, resolve });
  });
}

function resolvePendingConfirmation(
  map: PendingConfirmations,
  toolCallId: string,
  approved: boolean,
): boolean {
  const pending = map.get(toolCallId);
  if (!pending) return false;
  pending.resolve(approved);
  map.delete(toolCallId);
  return true;
}

// ---------------------------------------------------------------------------
// ACP runtime state
// ---------------------------------------------------------------------------

type ACPRuntime = {
  currentAgent: AgentState | null;
  pendingConfirmations: PendingConfirmations;
};

function createACPRuntime(): ACPRuntime {
  return {
    currentAgent: null,
    pendingConfirmations: createPendingConfirmations(),
  };
}

// ---------------------------------------------------------------------------
// Agent event → JSON-RPC event notification
// ---------------------------------------------------------------------------

function handleAgentEvent(
  event: AgentEvent,
  runtime: ACPRuntime,
  responseText: { current: string },
): void {
  // Forward the event to the editor as a notification
  writeMessage(jsonRpcEvent(event));

  // Accumulate text deltas
  if (event._tag === "text_delta") {
    responseText.current += event.text;
  }
}

// ---------------------------------------------------------------------------
// handleChatRequest — process a chat method request
// ---------------------------------------------------------------------------

async function handleChatRequest(
  id: JSONRPCID,
  params: { message: string; sessionId?: string },
  config: Config,
  runtime: ACPRuntime,
): Promise<void> {
  const providerRegistry = createProviderRegistry(config.providers);
  const toolRegistry = createDefaultRegistry();

  const agentConfig: AgentConfig = {
    provider: config.defaultProvider,
    model: config.defaultModel,
    maxTokens: config.compaction?.reserveTokens ?? 4096,
    tools: config.tools?.enabled ?? [],
    plugins: config.plugins?.enabled ?? [],
    providerRegistry,
    toolRegistry,
    workingDirectory: process.cwd(),
  };

  const state = createAgent(agentConfig);
  runtime.currentAgent = state;

  const message: Message = {
    id: crypto.randomUUID(),
    role: "user",
    content: params.message,
    createdAt: Date.now(),
  };

  const responseText: { current: string } = { current: "" };

  try {
    for await (const event of runAgent(state, message, agentConfig)) {
      handleAgentEvent(event, runtime, responseText);

      // If the agent needs permission, wait for the editor to confirm/deny
      if (event._tag === "permission_required") {
        const approved = await addPendingConfirmation(
          runtime.pendingConfirmations,
          event.toolCallId,
          event.tool,
          event.input,
        );
        // Signal approval/denial back to the agent
        // (agent implementation integrates via AbortController or tool config.
        // Denial is conveyed via a separate permission-signaling mechanism
        // that will be integrated when the agent supports it.)
        if (!approved) {
          // Permission denied — the agent loop is notified via abort signal
          // when full external permission signaling is implemented.
        }
      }
    }

    writeMessage(jsonRpcResult(id, { text: responseText.current }));
  } catch (err) {
    if (state.abortController.signal.aborted) {
      writeMessage(jsonRpcResult(id, { text: "[Aborted]" }));
    } else {
      const message = err instanceof Error ? err.message : String(err);
      writeMessage(jsonRpcError(id, ERROR_INTERNAL, message));
    }
  } finally {
    runtime.currentAgent = null;
  }
}

// ---------------------------------------------------------------------------
// handleJSONRPCRequest — dispatch a single JSON-RPC request
// ---------------------------------------------------------------------------

async function handleJSONRPCRequest(
  request: JSONRPCRequestMessage,
  config: Config,
  runtime: ACPRuntime,
): Promise<void> {
  const id = request.id ?? null;

  switch (request.method) {
    case "chat": {
      const p = request.params as { message: string; sessionId?: string };
      if (!p.message) {
        writeMessage(jsonRpcError(id, ERROR_INVALID_REQUEST, "Missing required param: message"));
        return;
      }
      await handleChatRequest(id, p, config, runtime);
      break;
    }

    case "tool/confirm": {
      const p = request.params as { toolCallId: string; approved: boolean };
      if (!p.toolCallId) {
        writeMessage(jsonRpcError(id, ERROR_INVALID_REQUEST, "Missing required param: toolCallId"));
        return;
      }
      const ok = resolvePendingConfirmation(runtime.pendingConfirmations, p.toolCallId, p.approved);
      if (!ok) {
        writeMessage(jsonRpcError(id, -1, `Unknown tool call: ${p.toolCallId}`));
        return;
      }
      writeMessage(jsonRpcResult(id, {}));
      break;
    }

    case "abort": {
      if (runtime.currentAgent) {
        abortAgent(runtime.currentAgent);
      }
      writeMessage(jsonRpcResult(id, {}));
      break;
    }

    case "session/list": {
      // Session listing requires a DB connection; return empty list for now.
      // Full implementation requires db/ import and proper session store.
      writeMessage(jsonRpcResult(id, { sessions: [] }));
      break;
    }

    case "session/create": {
      const p = request.params as { title?: string };
      const sessionId = crypto.randomUUID();
      writeMessage(jsonRpcResult(id, { sessionId }));
      break;
    }

    default: {
      writeMessage(jsonRpcError(id, ERROR_METHOD_NOT_FOUND, `Method not found: ${request.method}`));
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// parseJSONRPC — parse and validate a JSON-RPC request from a raw line
// ---------------------------------------------------------------------------

function parseJSONRPC(line: string): JSONRPCRequestMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    writeMessage(jsonRpcError(null, ERROR_PARSE, "Parse error"));
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    writeMessage(jsonRpcError(null, ERROR_INVALID_REQUEST, "Invalid Request: not an object"));
    return null;
  }

  const msg = parsed as Record<string, unknown>;

  if (msg.jsonrpc !== JSONRPC_VERSION) {
    writeMessage(
      jsonRpcError(null, ERROR_INVALID_REQUEST, "Invalid Request: must use JSON-RPC 2.0"),
    );
    return null;
  }

  if (typeof msg.method !== "string" || !msg.method) {
    writeMessage(jsonRpcError(null, ERROR_INVALID_REQUEST, "Invalid Request: missing method"));
    return null;
  }

  return msg as unknown as JSONRPCRequestMessage;
}

// ---------------------------------------------------------------------------
// runACPMode — start the ACP protocol loop
// ---------------------------------------------------------------------------

export async function runACPMode(config: Config): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  const runtime = createACPRuntime();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const request = parseJSONRPC(trimmed);
    if (!request) continue;

    // Handle each request asynchronously, but the readline loop
    // still processes the next line (stdin is the bottleneck)
    await handleJSONRPCRequest(request, config, runtime);
  }
}
