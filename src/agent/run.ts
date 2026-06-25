// Agent core loop (spec §3.3).
//
// Pure data + functions implementation of the agent execution loop:
//
//   createAgent(config) → AgentState
//   runAgent(state, message) → AsyncGenerator<AgentEvent>
//   abortAgent(state) → void
//   injectSteeringMessage(state, message) → void
//
// The agent loop:
//   1. Pushes the user message into the message history.
//   2. Builds a system prompt (tools, project context, skills, paradigm).
//   3. Calls LLM chatStream() to get a streaming response.
//   4. Iterates StreamChunks:
//      - text     → yield AgentEvent.text_delta, accumulate into response
//      - tool_call → check permission → execute tool → yield events →
//                     append tool result message → loop back to step 3
//      - thinking → yield AgentEvent.thinking
//      - usage    → yield AgentEvent.usage
//      - done     → exit inner stream loop
//      - error    → yield AgentEvent.error, exit
//   5. Before each LLM call, drains the steering queue and injects
//      any pending steering messages.
//   6. Checks the team mailbox for messages addressed to this agent
//      (when config.agentId is set) and injects them as system-level
//      context so the agent is aware of inter-agent communication.
//   7. Loops until LLM returns a final text response (no tool calls)
//      or max iterations is reached.
//
// Conventions: data + functions, no class, no this.

import { executeSlashCommand } from "../core/commands";
import { compactIfNeeded } from "../core/context";
import { recallAndInject } from "../core/memory";
import { buildSkillReminders } from "../core/skill-reminder";
import type {
  AgentError,
  AgentEvent,
  AgentState,
  AgentStatus,
  CommandContext,
  LLMDetail,
  Message,
  TokenBudget,
  ToolDef,
} from "../core/types";
import { recordToolResult } from "../core/tool-metrics";
import type { ChatMessage, ChatRequest, ChatTool, ProviderRegistry } from "../llm";
import {
  applyCacheOptimization,
  calculateCost,
  chatStream,
  chatStreamWithFallback,
  createCacheRegistry,
  getModelCapabilities,
  resolveModel,
} from "../llm";
import { runHooks } from "../plugins/hooks";
import { setHindsightSession } from "../plugins/hindsight";
import { drainMailbox, formatMailboxContext } from "../plugins/mailbox";
import {
  notifySessionStart,
  notifySessionEnd,
  notifyToolComplete,
  notifyToolError,
  notifyError,
} from "../plugins/session-notification";
import type { ToolRegistry, ToolResult } from "../tools";
import {
  executeTool,
  listTools,
  createSessionRevertStore,
  createPairValidatorState,
  validateToolCalls,
  formatViolations,
  hasCriticalViolation,
  type SessionRevertStore,
} from "../tools";
import { autoDetectTodosFromResponse } from "../session/todo-status";
import { buildSystemPrompt, convertMessageToChatMessage } from "./prompts";
import type { AgentConfig } from "./types";

// --- Cross-module imports --------------------------------------------------

import { emitLifecycleEvent } from "./lifecycle";
import {
  classifyThinkMode,
  classifyThinkingContent,
  createThinkModeState,
  selectModelForThinkMode,
  switchThinkMode,
} from "./think-mode";
import { partitionByWriteConflict } from "./write-conflict";
import {
  createAntiPatternState,
  recordToolCallEntry,
  detectRepeatedToolCalls,
  detectExcessiveToolCalls,
  detectShortLlmResponse,
} from "./anti-pattern";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS = 50;
const MAX_TOOL_CALLS_PER_TURN = 30;

// ---------------------------------------------------------------------------
// createAgent — factory for AgentState
// ---------------------------------------------------------------------------

export function createAgent(config: AgentConfig): AgentState {
  const total = config.maxTokens ?? 128_000;
  const reserved = Math.floor(total * 0.2);
  const available = total - reserved;

  const tokenBudget: TokenBudget = {
    total,
    reserved,
    available,
    used: 0,
    keepRecent: 10,
  };

  return {
    session: {
      id: config.sessionId ?? crypto.randomUUID(),
      title: "",
      parentId: null,
      branchPoint: null,
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages: [],
    tools: [],
    tokenBudget,
    abortController: new AbortController(),
    status: { _tag: "idle" },
    steeringQueue: [],
    llmDetails: [],
    resumeWaiters: [],
    cacheRegistry: createCacheRegistry(),
    thinkMode: createThinkModeState(),
  };
}

// ---------------------------------------------------------------------------
// abortAgent — signal cancellation
// ---------------------------------------------------------------------------

export function abortAgent(state: AgentState): void {
  state.abortController.abort();
  state.status = { _tag: "idle" };
}

// ---------------------------------------------------------------------------
// injectSteeringMessage — queue a system message for the next LLM turn
//
// Steering messages are injected as system-role messages just before the
// next LLM call. They do not persist in the conversation history.
// ---------------------------------------------------------------------------

export function injectSteeringMessage(state: AgentState, message: string): void {
  state.steeringQueue.push(message);
}

// ---------------------------------------------------------------------------
// pauseAgent / resumeAgent / waitForResume (spec §2.1)
// ---------------------------------------------------------------------------

/**
 * Pause the agent loop. The loop will block at the start of the next
 * iteration until `resumeAgent` is called.
 */
export function pauseAgent(state: AgentState, reason: string): void {
  if (state.status._tag !== "running") {
    throw new Error(`Cannot pause agent in ${state.status._tag} state (must be running)`);
  }
  state.status = { _tag: "paused", pauseReason: reason };
}

/**
 * Resume a paused agent. Wakes all waiters blocked on `waitForResume`.
 */
export function resumeAgent(state: AgentState): void {
  if (state.status._tag !== "paused") {
    throw new Error(`Cannot resume agent in ${state.status._tag} state (must be paused)`);
  }
  state.status = { _tag: "running", startedAt: Date.now() };
  // Wake all waiters
  for (const resolve of state.resumeWaiters) {
    resolve();
  }
  state.resumeWaiters.length = 0;
}

/**
 * Wait until the agent transitions out of paused state.
 * Resolves immediately if the agent is not currently paused.
 */
export function waitForResume(state: AgentState): Promise<void> {
  if (state.status._tag !== "paused") {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    state.resumeWaiters.push(resolve);
  });
}

// ---------------------------------------------------------------------------
// Status helpers (spec §19.2)
// ---------------------------------------------------------------------------

/**
 * Check whether the agent is currently in a paused state.
 */
export function isAgentPaused(state: AgentState): boolean {
  return state.status._tag === "paused";
}

/**
 * Return the current status of the agent.
 */
export function getAgentStatus(state: AgentState): AgentStatus {
  return state.status;
}

// ---------------------------------------------------------------------------
// runAgent — the main execution loop
//
// Returns an AsyncGenerator that yields AgentEvents as they occur.
// Callers iterate with `for await (const event of runAgent(state, msg))`.
// ---------------------------------------------------------------------------

export async function* runAgent(
  state: AgentState,
  message: Message,
  config: AgentConfig,
): AsyncGenerator<AgentEvent> {
  // Resolve registries from config
  const providerRegistry = config.providerRegistry;
  const toolRegistry = config.toolRegistry;

  // Resolve tool definitions from the registry
  const toolDefs = resolveToolDefs(toolRegistry, config.tools);
  state.tools = toolDefs;

  // Push user message
  state.messages.push(message);

  // Detect slash commands — if the user message starts with /, execute the
  // command instead of sending to the LLM.
  const textContent =
    typeof message.content === "string"
      ? message.content
      : (message.content.find((p) => p._tag === "text")?.text ?? "");

  if (message.role === "user" && textContent.startsWith("/")) {
    const spaceIdx = textContent.indexOf(" ");
    const name = spaceIdx === -1 ? textContent.slice(1) : textContent.slice(1, spaceIdx);
    const argsStr = spaceIdx === -1 ? "" : textContent.slice(spaceIdx + 1).trim();

    const ctx: CommandContext = {
      agent: state,
      session: state.session,
      config: {
        providers: [],
        defaultProvider: config.provider,
        defaultModel: config.model,
        roleRouting: {},
        fallback: { enabled: false, maxRetries: 0, retryDelay: 0 },
        compaction: config.compaction ?? {
          enabled: false,
          threshold: 0.8,
          reserveTokens: 10_000,
          keepRecentTokens: 4_000,
        },
        tools: { enabled: config.tools, disabled: [] },
        plugins: { enabled: config.plugins },
        mcpServers: [],
        slashCommands: { enabled: [] },
        theme: "system",
        locale: "en",
      },
    };

    const result = await executeSlashCommand(name, argsStr, ctx);
    switch (result._tag) {
      case "ok": {
        const outputMsg: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: result.output ?? "",
          createdAt: Date.now(),
        };
        state.messages.push(outputMsg);
        yield { _tag: "text_delta", text: result.output ?? "" };
        break;
      }
      case "error": {
        yield { _tag: "error", error: { _tag: "unknown", message: result.message } };
        break;
      }
      case "forked": {
        yield {
          _tag: "text_delta",
          text: `Forked to session ${result.sessionId} at message ${result.branchPoint}`,
        };
        break;
      }
      case "cancelled":
        break;
    }
    state.status = { _tag: "idle" };
    yield { _tag: "done" };
    return;
  }

  // Set status to running
  state.status = { _tag: "running", startedAt: Date.now() };

  // Create session-level revert store for cross-tool-call atomic rollback.
  const sessionRevertStore = createSessionRevertStore();

  // Emit agent_start lifecycle event
  emitLifecycleEvent(state, {
    _tag: "agent_start",
    timestamp: Date.now(),
    message,
  });

  // Session notification: start
  notifySessionStart(state.session.id).catch(() => {});

  // Set hindsight session context so the plugin can record lessons
  setHindsightSession(state.session.id);

  // Reset abort controller for this run
  state.abortController = new AbortController();

  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let iterations = 0;
  const antiPattern = createAntiPatternState();
  const pairValidator = createPairValidatorState();

  try {
    while (iterations < maxIterations) {
      iterations++;

      // Emit turn_start lifecycle event
      emitLifecycleEvent(state, {
        _tag: "turn_start",
        timestamp: Date.now(),
        iteration: iterations,
      });

      // Check for abort
      if (state.abortController.signal.aborted) {
        // Auto-revert all file modifications on abort.
        try {
          const revertEntries = await sessionRevertStore.rollbackEverything("Agent aborted");
          if (revertEntries.length > 0) {
            const revertedFiles = revertEntries.flatMap((e) => e.files);
            yield {
              _tag: "thinking",
              text: `[Auto-revert: rolled back ${revertedFiles.length} file(s) due to abort: ${revertedFiles.join(", ")}]`,
            };
          }
        } catch {
          // Revert failure must not mask the abort
        }

        const err: AgentError = { _tag: "aborted" };
        emitLifecycleEvent(state, {
          _tag: "agent_end",
          timestamp: Date.now(),
          status: { _tag: "error", error: err },
          reason: "aborted",
        });
        state.status = { _tag: "error", error: err };
        yield { _tag: "error", error: err };
        return;
      }

      // Check for paused state — block until resumed (spec §2.1)
      // Cast through unknown to defeat TypeScript's control-flow narrowing
      // after the `state.status = { _tag: "running" }` assignment above.
      if ((state.status as unknown as AgentStatus)._tag === "paused") {
        await waitForResume(state);
      }

      // Drain steering queue — inject as system messages at the end
      let steeringMessages = drainSteeringQueue(state);

      // Team mailbox: drain any pending messages addressed to this agent
      if (config.agentId) {
        const teamMessages = drainMailbox(config.agentId);
        if (teamMessages.length > 0) {
          const context = formatMailboxContext(teamMessages);
          steeringMessages = [...steeringMessages, context];
        }
      }

      // Hook: message:before — let plugins modify message history before LLM call
      let messagesForLlm = state.messages;
      if (config.pluginRegistry) {
        try {
          const beforeData = await runHooks(config.pluginRegistry, "message:before", {
            messages: state.messages,
          });
          messagesForLlm = beforeData.messages as Message[];
        } catch {
          // Hook failure must not interrupt the agent loop
        }
      }

      // MnemoPi: recall relevant memories and inject them as context.
      if (config.db) {
        messagesForLlm = await recallAndInject(config.db, messagesForLlm, {
          sessionId: state.session.id,
        });
      }

      // Build system prompt
      const systemPromptText = buildSystemPrompt({
        systemPrompt: config.systemPrompt,
        tools: toolDefs,
        skills: config.skills,
        projectInfo: config.projectInfo,
      });

      // Convert messages to ChatMessage wire format
      const chatMessages: ChatMessage[] = [
        { role: "system", content: systemPromptText },
        ...steeringMessages.map((text): ChatMessage => ({ role: "system", content: text })),
        ...messagesForLlm.map(convertMessageToChatMessage),
      ];

      // Build ChatTool definitions
      const chatTools: ChatTool[] = toolDefs.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters as ChatTool["parameters"],
      }));

      // Resolve model via role routing when available (spec §4.6)
      let resolvedProvider = config.provider;
      let resolvedModel = config.model;
      if (providerRegistry.routing) {
        try {
          const resolved = resolveModel(providerRegistry, { _tag: "default" });
          resolvedProvider = resolved.provider;
          resolvedModel = resolved.model;
        } catch {
          // Role routing not configured for "default" — keep config values
        }
      }

      // Think-mode system (§think-mode enhanced)
      {
        let effectiveMode = state.thinkMode.mode._tag;

        // If current mode is "auto", classify the message
        if (effectiveMode === "auto") {
          const classified = classifyThinkMode(textContent);
          if (classified._tag !== "none" && classified._tag !== "auto") {
            effectiveMode = classified._tag;
            state.thinkMode = switchThinkMode(state.thinkMode, classified, "keyword");
          }
        }

        // Select model if we have an active think mode
        if (effectiveMode !== "none") {
          const selectedModel = selectModelForThinkMode(providerRegistry, effectiveMode);
          if (selectedModel) {
            const currentCaps = getModelCapabilities(resolvedModel);
            if (!currentCaps.supportsThinking || effectiveMode !== "auto") {
              if (
                selectedModel.model !== resolvedModel ||
                selectedModel.provider !== resolvedProvider
              ) {
                state.thinkMode = {
                  ...state.thinkMode,
                  resolvedModel: selectedModel,
                };
                yield {
                  _tag: "think_mode_switch",
                  from: state.thinkMode.history.length > 0
                    ? state.thinkMode.history[state.thinkMode.history.length - 1].to
                    : "none",
                  to: effectiveMode,
                  model: selectedModel.model,
                };
                resolvedProvider = selectedModel.provider;
                resolvedModel = selectedModel.model;
              }
            }
          } else {
            yield {
              _tag: "warning",
              message: `Think-mode "${effectiveMode}" requested but no suitable model found in registry`,
              severity: "warning",
            };
          }
        }
      }

      // Skill category reminder
      const skillReminder = buildSkillReminders(textContent);
      if (skillReminder) {
        steeringMessages.push(skillReminder);
      }

      // Build request
      const request: ChatRequest = {
        model: resolvedProvider ? `${resolvedProvider}/${resolvedModel}` : resolvedModel,
        messages: chatMessages,
        tools: chatTools.length > 0 ? chatTools : undefined,
        stream: true as const,
        ...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
      };

      // Track LLM call detail
      const callStart = Date.now();
      let firstTokenAt: number | null = null;
      const detail: LLMDetail = {
        id: crypto.randomUUID(),
        timestamp: callStart,
        model: resolvedModel,
        provider: resolvedProvider,
        role: "default",
        systemPrompt: systemPromptText,
        messages: chatMessages,
        tools: chatTools,
        request,
        responseChunks: [],
        usage: { input: 0, output: 0 },
        latency: { firstToken: null, total: null },
        cost: null,
      };
      state.llmDetails.push(detail);

      // Stream the LLM response
      let hasToolCalls = false;
      const toolCalls: Array<{ id: string; name: string; args: string }> = [];
      let responseText = "";
      let thinkingText = "";

      // Apply cache optimization (§4.8)
      const optimizedRequest = state.cacheRegistry
        ? applyCacheOptimization(state.cacheRegistry, resolvedProvider, request)
        : request;

      // Hook: provider:before_request — allow plugins to modify the request
      const hookedReq = config.pluginRegistry
        ? ((
            await runHooks(config.pluginRegistry, "provider:before_request", {
              request: optimizedRequest,
            })
          ).request as ChatRequest)
        : optimizedRequest;

      // Use fallback chain when configured (spec §4.7), otherwise direct stream.
      const chain = providerRegistry.fallback;
      const stream = chain
        ? chatStreamWithFallback(providerRegistry, hookedReq, chain)
        : chatStream(providerRegistry, hookedReq);

      // Emit message_start lifecycle event
      emitLifecycleEvent(state, {
        _tag: "message_start",
        timestamp: Date.now(),
        request: hookedReq,
      });

      for await (const chunk of stream) {
        // Check abort between chunks
        if (state.abortController.signal.aborted) {
          try {
            const revertEntries = await sessionRevertStore.rollbackEverything("Agent aborted");
            if (revertEntries.length > 0) {
              const revertedFiles = revertEntries.flatMap((e) => e.files);
              yield {
                _tag: "thinking",
                text: `[Auto-revert: rolled back ${revertedFiles.length} file(s) due to abort: ${revertedFiles.join(", ")}]`,
              };
            }
          } catch {
            // Revert failure must not mask the abort
          }

          const err: AgentError = { _tag: "aborted" };
          emitLifecycleEvent(state, {
            _tag: "agent_end",
            timestamp: Date.now(),
            status: { _tag: "error", error: err },
            reason: "aborted",
          });
          state.status = { _tag: "error", error: err };
          yield { _tag: "error", error: err };
          return;
        }

        detail.responseChunks.push(chunk);

        switch (chunk._tag) {
          case "text": {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            responseText += chunk.text;
            yield { _tag: "text_delta", text: chunk.text };
            emitLifecycleEvent(state, {
              _tag: "message_delta",
              timestamp: Date.now(),
              text: chunk.text,
              accumulated: responseText,
            });
            break;
          }

          case "tool_call": {
            hasToolCalls = true;
            toolCalls.push({ id: chunk.id, name: chunk.name, args: chunk.args });
            yield {
              _tag: "tool_call",
              id: chunk.id,
              tool: chunk.name,
              input: chunk.args,
            };
            break;
          }

          case "thinking": {
            thinkingText += chunk.text;
            detail.thinking = thinkingText;
            state.thinkMode = {
              ...state.thinkMode,
              currentThinkingText: thinkingText,
            };
            yield { _tag: "thinking", text: chunk.text };
            emitLifecycleEvent(state, {
              _tag: "thinking_chunk",
              timestamp: Date.now(),
              text: chunk.text,
              accumulated: thinkingText,
            });
            break;
          }

          case "usage": {
            detail.usage.input += chunk.input;
            detail.usage.output += chunk.output;
            if (chunk.cacheRead)
              detail.usage.cacheHit = (detail.usage.cacheHit ?? 0) + chunk.cacheRead;
            state.tokenBudget.used += chunk.input + chunk.output;
            yield { _tag: "usage", input: chunk.input, output: chunk.output };
            break;
          }

          case "done": {
            const callEnd = Date.now();
            detail.latency.firstToken = firstTokenAt !== null ? firstTokenAt - callStart : null;
            detail.latency.total = callEnd - callStart;
            try {
              const caps = getModelCapabilities(config.model);
              detail.cost = calculateCost(caps, detail.usage.input, detail.usage.output);
            } catch {
              detail.cost = null;
            }
            break;
          }

          case "error": {
            try {
              const revertEntries = await sessionRevertStore.rollbackEverything(
                `LLM error: ${chunk.message}`,
              );
              if (revertEntries.length > 0) {
                const revertedFiles = revertEntries.flatMap((e) => e.files);
                yield {
                  _tag: "thinking",
                  text: `[Auto-revert: rolled back ${revertedFiles.length} file(s) due to LLM error: ${revertedFiles.join(", ")}]`,
                };
              }
            } catch {
              // Revert failure must not mask the LLM error
            }

            const err: AgentError = {
              _tag: "llm_error",
              message: chunk.message,
              retriable: chunk.retriable ?? false,
            };
            detail.error = err;
            detail.latency.total = Date.now() - callStart;
            detail.latency.firstToken = firstTokenAt !== null ? firstTokenAt - callStart : null;
            emitLifecycleEvent(state, {
              _tag: "agent_end",
              timestamp: Date.now(),
              status: { _tag: "error", error: err },
              reason: "error",
            });
            state.status = { _tag: "error", error: err };
            yield { _tag: "error", error: err };
            return;
          }
        }
      }

      // Emit message_end lifecycle event
      emitLifecycleEvent(state, {
        _tag: "message_end",
        timestamp: Date.now(),
        responseText,
        hasToolCalls,
        toolCount: toolCalls.length,
      });

      // Classify thinking content if we collected any during this response.
      if (thinkingText.trim()) {
        const classification = classifyThinkingContent(thinkingText);
        state.thinkMode = {
          ...state.thinkMode,
          classifications: [...state.thinkMode.classifications, classification],
        };
        yield { _tag: "thinking_classified", classification };
      }

      // Hook: provider:after_response — notify plugins of completed LLM response
      if (config.pluginRegistry) {
        try {
          await runHooks(config.pluginRegistry, "provider:after_response", {
            chunks: detail.responseChunks,
          });
        } catch {
          // Hook failure must not interrupt the agent loop
        }
      }

      // Hook: message:after — let plugins modify the assistant response
      if (config.pluginRegistry) {
        try {
          const afterMsg: Message = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: responseText,
            toolCalls:
              hasToolCalls && toolCalls.length > 0
                ? toolCalls.map((tc) => ({
                    id: tc.id,
                    name: tc.name,
                    arguments: tc.args,
                  }))
                : undefined,
            createdAt: Date.now(),
          };
          const afterData = await runHooks(config.pluginRegistry, "message:after", {
            message: afterMsg,
          });
          const modifiedMsg = afterData.message as Message;
          responseText =
            typeof modifiedMsg.content === "string"
              ? modifiedMsg.content
              : modifiedMsg.content
                  .filter((p): p is { _tag: "text"; text: string } => p._tag === "text")
                  .map((p) => p.text)
                  .join("");
        } catch {
          // Hook failure must not interrupt the agent loop
        }
      }

      // ------------------------------------------------------------------
      // Anti-pattern detection
      // ------------------------------------------------------------------

      // Record all tool calls from this iteration and check for violations
      for (const tc of toolCalls) {
        recordToolCallEntry(antiPattern, tc.name, tc.args);
      }

      // Check for repeated identical tool calls
      const repeatedViolation = detectRepeatedToolCalls(antiPattern);
      if (repeatedViolation) {
        yield {
          _tag: "warning",
          message: repeatedViolation.message,
          severity: repeatedViolation.severity,
        };
        if (repeatedViolation.severity === "critical") {
          emitLifecycleEvent(state, {
            _tag: "agent_end",
            timestamp: Date.now(),
            status: { _tag: "idle" },
            reason: "done",
          });
          state.status = { _tag: "idle" };
          yield { _tag: "done" };
          return;
        }
      }

      // Check for excessive tool calls in this turn
      const excessiveViolation = detectExcessiveToolCalls(antiPattern, MAX_TOOL_CALLS_PER_TURN);
      if (excessiveViolation) {
        yield {
          _tag: "warning",
          message: excessiveViolation.message,
          severity: excessiveViolation.severity,
        };
        emitLifecycleEvent(state, {
          _tag: "agent_end",
          timestamp: Date.now(),
          status: { _tag: "idle" },
          reason: "done",
        });
        state.status = { _tag: "idle" };
        yield { _tag: "done" };
        return;
      }

      // Check for suspiciously short LLM response (only when no tool calls)
      const shortViolation = detectShortLlmResponse(responseText, hasToolCalls);
      if (shortViolation) {
        yield {
          _tag: "warning",
          message: shortViolation.message,
          severity: shortViolation.severity,
        };
      }

      // ------------------------------------------------------------------
      // Tool-pair validation (spec §tool-pair)
      // ------------------------------------------------------------------

      if (hasToolCalls && toolCalls.length > 0) {
        const pairViolations = validateToolCalls(pairValidator, toolCalls);
        if (pairViolations.length > 0) {
          yield {
            _tag: "warning",
            message: formatViolations(pairViolations),
            severity: "warning",
          };

          if (hasCriticalViolation(pairViolations)) {
            emitLifecycleEvent(state, {
              _tag: "agent_end",
              timestamp: Date.now(),
              status: { _tag: "idle" },
              reason: "done",
            });
            state.status = { _tag: "idle" };
            yield { _tag: "done" };
            return;
          }
        }
      }

      // If there were tool calls, execute them and loop back
      if (hasToolCalls && toolCalls.length > 0) {
        // Append assistant message with tool calls
        const assistantMsg: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: responseText || "",
          toolCalls: toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.args,
          })),
          createdAt: Date.now(),
        };
        state.messages.push(assistantMsg);

        // Partition tool calls by write-conflict (spec §2.7)
        const groups = partitionByWriteConflict(toolCalls);
        const cwd = config.workingDirectory ?? process.cwd();

        // Yield parallel execution event
        yield {
          _tag: "tool_calls_parallel",
          calls: toolCalls.map((tc) => ({
            id: tc.id,
            tool: tc.name,
            input: tc.args,
          })),
        };

        // Execute each group sequentially; calls within a group run in parallel
        for (const group of groups) {
          // Check abort before each group
          if (state.abortController.signal.aborted) {
            try {
              const revertEntries = await sessionRevertStore.rollbackEverything("Agent aborted");
              if (revertEntries.length > 0) {
                const revertedFiles = revertEntries.flatMap((e) => e.files);
                yield {
                  _tag: "thinking",
                  text: `[Auto-revert: rolled back ${revertedFiles.length} file(s) due to abort: ${revertedFiles.join(", ")}]`,
                };
              }
            } catch {
              // Revert failure must not mask the abort
            }

            const err: AgentError = { _tag: "aborted" };
            emitLifecycleEvent(state, {
              _tag: "agent_end",
              timestamp: Date.now(),
              status: { _tag: "error", error: err },
              reason: "aborted",
            });
            state.status = { _tag: "error", error: err };
            yield { _tag: "error", error: err };
            return;
          }

          if (group.length === 1) {
            // Single call — execute directly
            const tc = group[0];
            // Hook: tool:before
            let toolInput: unknown = tc.args;
            if (config.pluginRegistry) {
              try {
                const beforeData = await runHooks(config.pluginRegistry, "tool:before", {
                  tool: tc.name,
                  input: tc.args,
                  ctx: { cwd },
                });
                toolInput = beforeData.input;
              } catch {
                // Hook failure must not interrupt the agent loop
              }
            }
            const toolStart = Date.now();
            emitLifecycleEvent(state, {
              _tag: "tool_execution_start",
              timestamp: toolStart,
              tool: tc.name,
              input: toolInput,
              callIndex: 0,
              totalCalls: 1,
            });
            const toolResult = await executeSingleTool(
              toolRegistry,
              tc.name,
              toolInput as string,
              state.abortController.signal,
              cwd,
              state.session.id,
              config.model,
              sessionRevertStore,
              tc.id,
            );
            // Hook: tool:after
            let finalResult = toolResult;
            if (config.pluginRegistry) {
              try {
                const afterData = await runHooks(config.pluginRegistry, "tool:after", {
                  tool: tc.name,
                  input: toolInput,
                  result: toolResult,
                  ctx: { cwd },
                });
                finalResult = afterData.result as ToolResult;
              } catch {
                // Hook failure must not interrupt the agent loop
              }
            }
            // §16.5 — record tool metrics after execution
            const alreadyRecorded =
              finalResult._tag === "success" && finalResult.metadata?.mode !== undefined;
            if (!alreadyRecorded) {
              recordToolResult({
                model: config.model,
                tool: tc.name,
                mode: "default",
                success: finalResult._tag !== "error",
                latency: Date.now() - toolStart,
              });
            }
            emitLifecycleEvent(state, {
              _tag: "tool_execution_end",
              timestamp: Date.now(),
              tool: tc.name,
              input: toolInput,
              result: finalResult,
              latency: Date.now() - toolStart,
              success: finalResult._tag !== "error",
            });

            // Session notification: tool result
            if (finalResult._tag === "error") {
              notifyToolError(state.session.id, tc.name, finalResult.error).catch(() => {});
            } else {
              const summary = `Tool ${tc.name} completed`;
              notifyToolComplete(state.session.id, tc.name, summary).catch(() => {});
            }

            yield {
              _tag: "tool_result",
              id: tc.id,
              tool: tc.name,
              output: finalResult,
            };
            if (finalResult._tag === "permission_required") {
              yield {
                _tag: "permission_required",
                toolCallId: tc.id,
                tool: tc.name,
                input: tc.args,
              };
            }
            state.messages.push({
              id: crypto.randomUUID(),
              role: "tool",
              content: formatToolResult(finalResult),
              toolCallId: tc.id,
              name: tc.name,
              createdAt: Date.now(),
            });
          } else {
            // Multiple calls — run in parallel with Promise.allSettled
            emitLifecycleEvent(state, {
              _tag: "parallel_tool_execution_start",
              timestamp: Date.now(),
              groupIndex: groups.indexOf(group),
              totalGroups: groups.length,
              calls: group.length,
            });
            const settled = await Promise.allSettled(
              group.map((tc) =>
                (async () => {
                  // Hook: tool:before
                  let toolInput: unknown = tc.args;
                  if (config.pluginRegistry) {
                    try {
                      const beforeData = await runHooks(config.pluginRegistry, "tool:before", {
                        tool: tc.name,
                        input: tc.args,
                        ctx: { cwd },
                      });
                      toolInput = beforeData.input;
                    } catch {
                      // Hook failure must not interrupt the agent loop
                    }
                  }
                  const toolStart = Date.now();
                  const result = await executeSingleTool(
                    toolRegistry,
                    tc.name,
                    toolInput as string,
                    state.abortController.signal,
                    cwd,
                    state.session.id,
                    config.model,
                    sessionRevertStore,
                    tc.id,
                  );
                  // Hook: tool:after
                  let finalResult = result;
                  if (config.pluginRegistry) {
                    try {
                      const afterData = await runHooks(config.pluginRegistry, "tool:after", {
                        tool: tc.name,
                        input: toolInput,
                        result,
                        ctx: { cwd },
                      });
                      finalResult = afterData.result as ToolResult;
                    } catch {
                      // Hook failure must not interrupt the agent loop
                    }
                  }
                  // §16.5 — record tool metrics after execution
                  const alreadyRecorded2 =
                    finalResult._tag === "success" && finalResult.metadata?.mode !== undefined;
                  if (!alreadyRecorded2) {
                    recordToolResult({
                      model: config.model,
                      tool: tc.name,
                      mode: "default",
                      success: finalResult._tag !== "error",
                      latency: Date.now() - toolStart,
                    });
                  }
                  return { tc, result: finalResult };
                })(),
              ),
            );

            // Yield results in order
            for (const entry of settled) {
              if (entry.status === "fulfilled") {
                const { tc, result } = entry.value;
                yield {
                  _tag: "tool_result",
                  id: tc.id,
                  tool: tc.name,
                  output: result,
                };
                if (result._tag === "permission_required") {
                  yield {
                    _tag: "permission_required",
                    toolCallId: tc.id,
                    tool: tc.name,
                    input: tc.args,
                  };
                }
                state.messages.push({
                  id: crypto.randomUUID(),
                  role: "tool",
                  content: formatToolResult(result),
                  toolCallId: tc.id,
                  name: tc.name,
                  createdAt: Date.now(),
                });
              } else {
                const idx = settled.indexOf(entry);
                const tc = group[idx];
                const errorResult: ToolResult = {
                  _tag: "error",
                  error:
                    entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
                };
                yield {
                  _tag: "tool_result",
                  id: tc.id,
                  tool: tc.name,
                  output: errorResult,
                };
                state.messages.push({
                  id: crypto.randomUUID(),
                  role: "tool",
                  content: formatToolResult(errorResult),
                  toolCallId: tc.id,
                  name: tc.name,
                  createdAt: Date.now(),
                });
              }
            }
          }
        }

        // Emit turn_end lifecycle event (after tool execution)
        emitLifecycleEvent(state, {
          _tag: "turn_end",
          timestamp: Date.now(),
          iteration: iterations,
          hasToolCalls: true,
          toolCallsExecuted: toolCalls.length,
        });

        // After tool execution, check if context compaction is needed.
        try {
          const compacted = await compactIfNeeded({
            messages: state.messages,
            tokenBudget: state.tokenBudget,
            compactionConfig: config.compaction,
          });
          if (compacted) {
            yield {
              _tag: "thinking",
              text: "[Context compacted: older messages summarized]",
            };
          }
        } catch (err) {
          yield {
            _tag: "error",
            error: {
              _tag: "compaction_error",
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }

        // Loop back to step 3 — LLM will see tool results
        continue;
      }

      // No tool calls — this is a final text response.
      if (responseText) {
        const finalMsg: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: responseText,
          createdAt: Date.now(),
        };
        state.messages.push(finalMsg);
      }

      // Auto-detect TODO items from the response text
      if (config.db && responseText) {
        try {
          const created = await autoDetectTodosFromResponse(
            config.db,
            state.session.id,
            responseText,
          );
          if (created > 0) {
            yield {
              _tag: "thinking",
              text: `[Auto-tracked ${created} TODO item(s) from response]`,
            };
          }
        } catch {
          // TODO detection failure must not interrupt the agent loop
        }
      }

      // Post-response compaction check
      try {
        const compacted = await compactIfNeeded({
          messages: state.messages,
          tokenBudget: state.tokenBudget,
          compactionConfig: config.compaction,
        });
        if (compacted) {
          yield {
            _tag: "thinking",
            text: "[Context compacted: older messages summarized]",
          };
        }
      } catch (err) {
        yield {
          _tag: "error",
          error: {
            _tag: "compaction_error",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }

      // Emit turn_end lifecycle event (final text response, no tool calls)
      emitLifecycleEvent(state, {
        _tag: "turn_end",
        timestamp: Date.now(),
        iteration: iterations,
        hasToolCalls: false,
        toolCallsExecuted: 0,
      });

      // Emit agent_end lifecycle event
      emitLifecycleEvent(state, {
        _tag: "agent_end",
        timestamp: Date.now(),
        status: { _tag: "idle" },
        reason: "done",
      });

      // Done
      notifySessionEnd(state.session.id, "Session completed successfully").catch(() => {});

      state.status = { _tag: "idle" };
      yield { _tag: "done" };
      return;
    }

    // Max iterations reached
    try {
      const revertEntries = await sessionRevertStore.rollbackEverything(
        `Maximum iterations (${maxIterations}) reached`,
      );
      if (revertEntries.length > 0) {
        const revertedFiles = revertEntries.flatMap((e) => e.files);
        yield {
          _tag: "thinking",
          text: `[Auto-revert: rolled back ${revertedFiles.length} file(s) due to max iterations: ${revertedFiles.join(", ")}]`,
        };
      }
    } catch {
      // Revert failure must not mask the original error
    }

    emitLifecycleEvent(state, {
      _tag: "agent_end",
      timestamp: Date.now(),
      status: { _tag: "error", error: { _tag: "unknown", message: `Maximum iterations (${maxIterations}) reached` } },
      reason: "max_iterations",
    });
    const err: AgentError = {
      _tag: "unknown",
      message: `Maximum iterations (${maxIterations}) reached`,
    };

    notifySessionEnd(state.session.id, `Maximum iterations (${maxIterations}) reached`).catch(() => {});

    state.status = { _tag: "error", error: err };
    yield { _tag: "error", error: err };
  } catch (error) {
    try {
      const revertEntries = await sessionRevertStore.rollbackEverything(
        `Agent error: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (revertEntries.length > 0) {
        const revertedFiles = revertEntries.flatMap((e) => e.files);
        yield {
          _tag: "thinking",
          text: `[Auto-revert: rolled back ${revertedFiles.length} file(s) due to agent error: ${revertedFiles.join(", ")}]`,
        };
      }
    } catch {
      // Revert failure must not mask the original error
    }

    const err: AgentError = {
      _tag: "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
    emitLifecycleEvent(state, {
      _tag: "agent_end",
      timestamp: Date.now(),
      status: { _tag: "error", error: err },
      reason: "error",
    });

    notifyError(state.session.id, err.message).catch(() => {});
    notifySessionEnd(state.session.id, `Session ended with error: ${err.message}`).catch(() => {});

    state.status = { _tag: "error", error: err };
    yield { _tag: "error", error: err };
  } finally {
    setHindsightSession(null);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve tool definitions from the registry based on the enabled tool names.
 * If the tool name list is empty, all registered tools are included.
 */
function resolveToolDefs(registry: ToolRegistry, enabledNames: string[]): ToolDef[] {
  const allTools = listTools(registry);
  const coreTools = allTools as unknown as ToolDef[];
  if (enabledNames.length === 0) return coreTools;
  const nameSet = new Set(enabledNames);
  return coreTools.filter((t) => nameSet.has(t.name));
}

/**
 * Drain the steering queue, returning all pending messages and clearing the queue.
 */
function drainSteeringQueue(state: AgentState): string[] {
  const messages = [...state.steeringQueue];
  state.steeringQueue.length = 0;
  return messages;
}

/**
 * Execute a single tool call, catching errors and normalizing the result.
 */
async function executeSingleTool(
  registry: ToolRegistry,
  name: string,
  args: string,
  signal: AbortSignal,
  cwd: string,
  sessionId: string,
  model?: string,
  sessionRevertStore?: SessionRevertStore,
  callId?: string,
): Promise<ToolResult> {
  let parsedArgs: unknown;
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (trimmed === "") {
      parsedArgs = {};
    } else {
      try {
        parsedArgs = JSON.parse(trimmed);
      } catch {
        return {
          _tag: "error",
          error: `Tool "${name}" received invalid JSON arguments: ${args.slice(0, 200)}`,
        };
      }
    }
  } else {
    parsedArgs = args;
  }

  const ctx = {
    cwd,
    session: { id: sessionId, cwd },
    abort: signal,
    model,
  };

  return executeTool(
    registry,
    name,
    parsedArgs,
    ctx,
    undefined,
    sessionRevertStore,
    callId,
  );
}

/**
 * Format a ToolResult into a string for the tool-role message content.
 */
function formatToolResult(result: ToolResult): string {
  switch (result._tag) {
    case "success":
      return result.output;
    case "error":
      return `Error: ${result.error}`;
    case "permission_required":
      return `Permission required: ${result.reason}`;
    case "truncated":
      return result.output;
  }
}
