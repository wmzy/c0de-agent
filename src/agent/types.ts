// Agent module types (re-exports from core + agent-specific additions).
//
// The canonical type definitions for AgentConfig, AgentState, AgentEvent,
// AgentStatus, AgentError, TokenBudget, etc. live in src/core/types.ts.
// This file re-exports them for convenient consumption and adds any
// agent-module-specific types that don't belong in core.
//
// Conventions: data + functions only, no class, no interface, no enum.

import type {
  CompactionConfig,
  AgentConfig as CoreAgentConfig,
  AgentError as CoreAgentError,
  AgentEvent as CoreAgentEvent,
  AgentState as CoreAgentState,
  AgentStatus as CoreAgentStatus,
  Message,
  ProjectInfo,
  Skill,
} from "../core/types";
import type { DB } from "../db";
import type { ChatRequest, ProviderRegistry } from "../llm";
import type { PluginRegistry } from "../plugins/types";
import type { ToolRegistry, ToolResult } from "../tools";

// ---------------------------------------------------------------------------
// Re-exports from core (canonical definitions)
// ---------------------------------------------------------------------------

export type {
  AgentConfig as CoreAgentConfig,
  AgentState as CoreAgentState,
  AgentEvent as CoreAgentEvent,
  AgentStatus as CoreAgentStatus,
  AgentError as CoreAgentError,
  TokenBudget,
  CompactionConfig,
  LLMDetail,
  Message,
  Skill,
  ProjectInfo,
  ThinkMode,
  ThinkModeState,
  ThinkingClassification,
} from "../core/types";

export { THINK_MODES } from "../core/types";

// ---------------------------------------------------------------------------
// Agent config — extends core AgentConfig with runtime dependencies
//
// The core AgentConfig is a pure data description (provider name, model,
// tool list, etc.). The agent module needs live references to the provider
// registry and tool registry to actually execute the loop.
// ---------------------------------------------------------------------------

export type AgentConfig = CoreAgentConfig & {
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  pluginRegistry?: PluginRegistry;
  db?: DB;
  workingDirectory?: string;
  maxIterations?: number;
  systemPrompt?: string;
  skills?: Skill[];
  projectInfo?: ProjectInfo;
  compaction?: CompactionConfig;
  /**
   * Agent identity for team mailbox communication.
   * When set, the agent loop will automatically check the team mailbox
   * for messages addressed to this agent and inject them as steering
   * context before each LLM turn.
   */
  agentId?: string;
  /**
   * Real DB session id. When provided, AgentState.session.id is set to this
   * value instead of a random UUID, so lifecycle events, notifications,
   * hindsight, and TODOs reference the correct DB session.
   */
  sessionId?: string;
};

// Re-export core AgentState, AgentEvent, AgentStatus under the same names
// so consumers can import from either agent/ or core/.
export type AgentState = CoreAgentState;
export type AgentEvent = CoreAgentEvent;
export type AgentStatus = CoreAgentStatus;
export type AgentError = CoreAgentError;

// ---------------------------------------------------------------------------
// Lifecycle events — emitted at key points during agent execution
//
// Consumers subscribe via subscribeLifecycle() to observe the agent's
// lifecycle without participating in the event stream.
// ---------------------------------------------------------------------------

/**
 * A lifecycle event emitted during agent execution.
 * Each variant captures the context-specific data available at that point
 * in the loop.
 */
export type LifecycleEvent =
  | { _tag: "agent_start"; timestamp: number; message: Message }
  | { _tag: "turn_start"; timestamp: number; iteration: number }
  | { _tag: "message_start"; timestamp: number; request: ChatRequest }
  | { _tag: "message_delta"; timestamp: number; text: string; accumulated: string }
  | { _tag: "message_end"; timestamp: number; responseText: string; hasToolCalls: boolean; toolCount: number }
  | { _tag: "tool_execution_start"; timestamp: number; tool: string; input: unknown; callIndex: number; totalCalls: number }
  | { _tag: "tool_execution_end"; timestamp: number; tool: string; input: unknown; result: ToolResult; latency: number; success: boolean }
  | { _tag: "parallel_tool_execution_start"; timestamp: number; groupIndex: number; totalGroups: number; calls: number }
  | { _tag: "parallel_tool_execution_end"; timestamp: number; groupIndex: number; totalGroups: number; results: number }
  | { _tag: "turn_end"; timestamp: number; iteration: number; hasToolCalls: boolean; toolCallsExecuted: number }
  | { _tag: "agent_end"; timestamp: number; status: AgentStatus; reason: "done" | "error" | "aborted" | "max_iterations" }
  | { _tag: "thinking_chunk"; timestamp: number; text: string; accumulated: string };
