// Core type definitions for the agent loop, configuration, and prompt building.
//
// Design rules followed:
//   - data + functions only (no class, no this, no enum)
//   - variants tagged via `_tag` field, dispatched via switch on `_tag`
//   - all composite shapes declared with `type`, never `interface`
//
// Cross-package type ownership (per design spec §4.2, §5.2, §8.2):
//   - llm/    owns protocol-level types: ChatMessage, ChatTool, ChatRequest,
//             StreamChunk, ProviderConfig
//   - core/   owns: AgentConfig, AgentState, AgentEvent, AgentStatus,
//             AgentError, TokenBudget, CompactionConfig, LLMDetail,
//             PromptSection, PromptContext, Config,
//             ToolResult, ToolDef, ToolContext, ToolPermission
//             (canonical definitions; tools/types.ts re-exports them)
//   - session/owns: Session, Message (session-level copy lives here in core)

import type {
  CacheRegistry,
  ChatMessage,
  ChatRequest,
  ChatTool,
  ProviderConfig,
  StreamChunk,
} from "../llm";
import type { Session } from "../session";

// ---------------------------------------------------------------------------
// Generic structural primitives (lightweight, protocol-neutral)
// ---------------------------------------------------------------------------

export type JSONSchema =
  | {
      type: "object";
      properties?: Record<string, JSONSchema>;
      required?: string[];
      additionalProperties?: boolean | JSONSchema;
      description?: string;
      default?: unknown;
    }
  | {
      type: "array";
      items: JSONSchema;
      description?: string;
      minItems?: number;
      maxItems?: number;
    }
  | {
      type: "string";
      description?: string;
      enum?: string[];
      default?: string;
    }
  | { type: "number"; description?: string; default?: number; minimum?: number; maximum?: number }
  | { type: "integer"; description?: string; default?: number; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string; default?: boolean }
  | { type: "null" }
  | { type: "union"; anyOf: JSONSchema[]; description?: string };

// ---------------------------------------------------------------------------
// Tool-related types — canonical definitions live here.
// tools/types.ts re-exports these; tools-specific helpers (ToolExecutor,
// ToolMode, SessionRef, ToolRegistry) remain in tools/types.ts.
// ---------------------------------------------------------------------------

export type ToolPermission = "auto" | "ask" | "deny";

export type ToolResult =
  | { _tag: "success"; output: string; metadata?: Record<string, unknown> }
  | { _tag: "error"; error: string }
  | { _tag: "permission_required"; reason: string }
  | { _tag: "truncated"; output: string; truncated: boolean; totalLines: number };

export type ToolDef = {
  name: string;
  description: string;
  parameters: JSONSchema;
  permission: ToolPermission;
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult>;
};

export type ToolContext = {
  cwd: string;
  session: { id: string; cwd: string };
  abort: AbortSignal;
  model?: string;
};

// ---------------------------------------------------------------------------
// Think-mode types (§think-mode enhanced)
//
// Multi-mode thinking support: quick / thorough / creative / auto / none.
// Each mode maps to different model selection strategies and system prompt
// adjustments. Inspired by Oh-My-OpenAgent's auto-switching patterns.
// ---------------------------------------------------------------------------

/** Available thinking modes. */
export type ThinkMode =
  | { readonly _tag: "quick" }
  | { readonly _tag: "thorough" }
  | { readonly _tag: "creative" }
  | { readonly _tag: "auto" }
  | { readonly _tag: "none" };

export const THINK_MODES: ReadonlyArray<ThinkMode["_tag"]> = [
  "quick",
  "thorough",
  "creative",
  "auto",
  "none",
];

/** Metadata about how thinking content was classified. */
export type ThinkingClassification =
  | { _tag: "analytical"; confidence: number }
  | { _tag: "creative"; confidence: number }
  | { _tag: "planning"; confidence: number }
  | { _tag: "verification"; confidence: number }
  | { _tag: "general"; confidence: number };

/** Extended think-mode state attached to AgentState. */
export type ThinkModeState = {
  /** Current active think mode. */
  mode: ThinkMode;
  /** Model override chosen for this mode (provider/model). */
  resolvedModel?: { provider: string; model: string };
  /** Classifications of thinking content from the current/last LLM response. */
  classifications: ThinkingClassification[];
  /** Accumulated thinking text from the current response. */
  currentThinkingText: string;
  /** History of mode switches in this session. */
  history: Array<{
    from: ThinkMode["_tag"];
    to: ThinkMode["_tag"];
    timestamp: number;
    reason: "auto" | "user" | "keyword";
  }>;
};

// ---------------------------------------------------------------------------
// Session-level Message type (per spec §4.2: Core owns Message, llm owns
// ChatMessage). Core converts Message -> ChatMessage before handing to llm.
// ---------------------------------------------------------------------------

export type MessageContentPart =
  | { _tag: "text"; text: string }
  | { _tag: "image"; url: string; alt?: string }
  | { _tag: "reference"; path: string; startLine: number; endLine: number };

export type Message = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string | MessageContentPart[];
  toolCallId?: string;
  toolCalls?: {
    id: string;
    name: string;
    arguments: string;
    output?: string;
    error?: string;
    status?: "pending" | "running" | "done" | "error";
  }[];
  name?: string;
  createdAt: number;
};

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export type AgentConfig = {
  provider: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  tools: string[];
  plugins: string[];
};

// ---------------------------------------------------------------------------
// Token budgeting + compaction
// ---------------------------------------------------------------------------

export type TokenBudget = {
  total: number;
  reserved: number;
  available: number;
  used: number;
  keepRecent: number;
};

export type CompactionConfig = {
  enabled: boolean;
  threshold: number;
  reserveTokens: number;
  keepRecentTokens: number;
};

// ---------------------------------------------------------------------------
// Agent runtime state
// ---------------------------------------------------------------------------

export type AgentStatus =
  | { _tag: "idle" }
  | { _tag: "running"; startedAt: number }
  | { _tag: "paused"; pauseReason: string }
  | { _tag: "error"; error: AgentError };

export type AgentError =
  | { _tag: "aborted" }
  | { _tag: "llm_error"; message: string; provider?: string; retriable: boolean }
  | { _tag: "tool_error"; tool: string; message: string }
  | { _tag: "permission_denied"; tool: string; reason: string }
  | { _tag: "compaction_error"; message: string }
  | { _tag: "unknown"; message: string };

export type LLMDetail = {
  id: string;
  timestamp: number;
  model: string;
  provider: string;
  role: string;
  systemPrompt: string;
  messages: ChatMessage[];
  tools: ChatTool[];
  request: ChatRequest;
  responseChunks: StreamChunk[];
  thinking?: string;
  usage: { input: number; output: number; cacheHit?: number };
  latency: { firstToken: number | null; total: number | null };
  cost: number | null;
  error?: AgentError;
};

export type AgentState = {
  session: Session;
  messages: Message[];
  tools: ToolDef[];
  tokenBudget: TokenBudget;
  abortController: AbortController;
  status: AgentStatus;
  steeringQueue: string[];
  llmDetails: LLMDetail[];
  resumeWaiters: Array<() => void>;
  cacheRegistry?: CacheRegistry;
  /** Think-mode runtime state. */
  thinkMode: ThinkModeState;
};

// ---------------------------------------------------------------------------
// Agent event stream (emitted by runAgent's AsyncGenerator)
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { _tag: "text_delta"; text: string }
  | { _tag: "tool_call"; id: string; tool: string; input: unknown }
  | { _tag: "tool_calls_parallel"; calls: Array<{ id: string; tool: string; input: unknown }> }
  | { _tag: "tool_result"; id: string; tool: string; output: ToolResult }
  | { _tag: "thinking"; text: string }
  | { _tag: "usage"; input: number; output: number }
  | { _tag: "error"; error: AgentError }
  | { _tag: "permission_required"; toolCallId: string; tool: string; input: unknown }
  | { _tag: "warning"; message: string; severity: "warning" | "critical" }
  | { _tag: "think_mode_switch"; from: ThinkMode["_tag"]; to: ThinkMode["_tag"]; model?: string }
  | { _tag: "thinking_classified"; classification: ThinkingClassification }
  | { _tag: "done" };

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export type ProjectInfo = {
  rootDir: string;
  name?: string;
  language?: string;
  fileCount?: number;
  gitBranch?: string;
  gitStatus?: "clean" | "dirty" | "unknown";
  packageManager?: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
  dependencies?: string[];
};

export type Skill = {
  name: string;
  description: string;
  content: string;
  enabled: boolean;
};

export type PromptSection = {
  id: string;
  title: string;
  content: string;
  priority: number;
  condition?: (ctx: PromptBuildContext) => boolean;
};

export type PromptBuildContext = {
  tools: ToolDef[];
  agents: { name: string; description: string }[];
  skills: Skill[];
  projectInfo: ProjectInfo;
  config: AgentConfig;
  session: Session;
};

export type PromptContext = PromptBuildContext;

export type PromptRegistry = {
  sections: PromptSection[];
};

// ---------------------------------------------------------------------------
// Configuration (per spec §3.5)
// ---------------------------------------------------------------------------

export type MCPServerConfig = {
  name: string;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
};

export type Config = {
  providers: ProviderConfig[];
  defaultProvider: string;
  defaultModel: string;
  roleRouting: Record<string, { provider: string; model: string }>;
  fallback: { enabled: boolean; maxRetries: number; retryDelay: number };
  compaction: CompactionConfig;
  tools: { enabled: string[]; disabled: string[] };
  plugins: { enabled: string[] };
  mcpServers: MCPServerConfig[];
  slashCommands: { enabled: string[] };
  theme: "light" | "dark" | "system";
  locale: string;
};

// ---------------------------------------------------------------------------
// Hook / command types referenced by agent loop (full hook implementation
// lives in plugins/, but the shape is fixed here so the agent can yield it.)
// ---------------------------------------------------------------------------

export type AgentHookMap = {
  before_tool_call: { tool: string; input: unknown; ctx: ToolContext };
  after_tool_call: { tool: string; input: unknown; result: ToolResult; ctx: ToolContext };
  before_provider_request: { request: ChatRequest };
  after_provider_response: { chunks: StreamChunk[] };
  "session:create": { session: Session };
  "session:fork": { source: Session; fork: Session };
  "message:before": { messages: Message[] };
  "message:after": { message: Message };
};

export type CommandResult =
  | { _tag: "ok"; output?: string }
  | { _tag: "error"; message: string }
  | { _tag: "cancelled" }
  | { _tag: "forked"; sessionId: string; branchPoint: number };

export type CommandContext = {
  agent: AgentState;
  session: Session;
  config: Config;
};

export type SlashCommand = {
  name: string;
  description: string;
  args?: JSONSchema;
  execute: (args: unknown, ctx: CommandContext) => Promise<CommandResult>;
};


