// Built-in `task` tool (§5.4).
//
// Creates a sub-agent to run an independent task. The sub-agent operates in
// its own ephemeral session with its own tool registry and LLM conversation.
//
// Parameters:
//   prompt    — the instruction for the sub-agent
//   model     — optional model override (e.g. "openai/gpt-4o-mini")
//
// Returns the sub-agent's final output text.
//
// Conventions: data + functions, no class, no this.

import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "../core/config";
import type { Config } from "../core/types";
import type {
  ChatMessage,
  ChatRequest,
  ChatTool,
  ProviderConfig,
  ProviderRegistry,
  StreamChunk,
} from "../llm";
import { chatStream, createProviderRegistry } from "../llm";
import { createMemoryStore } from "../session";
import type { SessionStore } from "../session/types";
import { ok, err, type ToolContext, type ToolDef, type ToolResult } from "./types";

// ---------------------------------------------------------------------------
// Module-level session store — shared across task invocations so session
// references stay valid within a process lifetime.
// ---------------------------------------------------------------------------

const sessionStore: SessionStore = createMemoryStore();

// ---------------------------------------------------------------------------
// Minimal tool spec for the sub-agent
//
// Sub-agents get a restricted tool set: they can only produce text output
// (no shell, no file writes) unless the parent session explicitly grants more.
// For now we omit tool definitions since the sub-agent's job is to reason
// and return text.
// ---------------------------------------------------------------------------

const SUB_AGENT_TOOLS: ChatTool[] = [];

// ---------------------------------------------------------------------------
// Sub-agent system prompt
// ---------------------------------------------------------------------------

function buildSubAgentSystemPrompt(): string {
  return [
    "You are a helpful sub-agent assistant running inside the c0de-agent harness.",
    "Your job is to complete the assigned task and return a concise, useful result.",
    "",
    "Guidelines:",
    "- Focus on the exact task given — do not exceed scope.",
    "- Return concrete results: code, analysis, or actionable information.",
    "- Be concise but complete. Include all necessary code and explanations.",
    "- Do not ask follow-up questions — work with what you have.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Resolve provider configuration
//
// Tries to load config from the project directory, falling back to defaults.
// Creates a provider registry with whatever providers are configured.
// ---------------------------------------------------------------------------

async function resolveProviderRegistry(
  cwd: string,
): Promise<{ registry: ProviderRegistry; defaultModel: string }> {
  let config: Config;
  try {
    config = await loadConfig(cwd);
  } catch {
    config = mergeConfig(DEFAULT_CONFIG);
  }

  const providers: ProviderConfig[] = config.providers ?? [];
  const registry = createProviderRegistry(providers);

  // Determine default model from config
  const defaultModel: string =
    config.defaultProvider && config.defaultModel
      ? `${config.defaultProvider}/${config.defaultModel}`
      : providers.length > 0
        ? `${providers[0]._tag}/${providers[0]._tag === "openai" ? "gpt-4o" : "claude-sonnet-4-20250514"}`
        : "";

  return { registry, defaultModel };
}

// ---------------------------------------------------------------------------
// Aggregate stream chunks into a single text response
// ---------------------------------------------------------------------------

async function collectStreamOutput(
  stream: AsyncGenerator<StreamChunk>,
  signal: AbortSignal,
): Promise<string> {
  const parts: string[] = [];

  for await (const chunk of stream) {
    if (signal.aborted) break;

    switch (chunk._tag) {
      case "text": {
        parts.push(chunk.text);
        break;
      }
      case "thinking": {
        // Sub-agent thinking is discarded in the output but could be logged
        break;
      }
      case "done": {
        return parts.join("");
      }
      case "error": {
        throw new Error(`LLM error: ${chunk.message}`);
      }
      case "tool_call": {
        // Sub-agents currently don't execute tools
        break;
      }
      case "usage": {
        // Usage stats tracked but not surfaced for sub-agents
        break;
      }
    }
  }

  return parts.join("");
}

// ---------------------------------------------------------------------------
// taskTool
// ---------------------------------------------------------------------------

export const taskTool: ToolDef = {
  name: "task",
  description:
    "Spawn a sub-agent to run an independent task. The sub-agent gets its own " +
    "session and LLM conversation, and returns its final output as text. Use for " +
    "parallelizable independent work, research questions, or isolated code generation " +
    "tasks that don't need to interact with the main session's files or tools.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "The full instruction for the sub-agent. Be specific about what the sub-agent " +
          "should do, what format the output should take, and any constraints it must follow. " +
          "Treat this like a task assignment to a capable engineer.",
      },
      model: {
        type: "string",
        description:
          "Optional model override. Format: 'provider/model' (e.g. 'openai/gpt-4o-mini', " +
          "'anthropic/claude-sonnet-4-20250514'). Defaults to the session's default model.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  permission: "auto",

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;

    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (prompt.length === 0) {
      return err('task: "prompt" argument is required');
    }

    const modelOverride =
      typeof args.model === "string" && args.model.length > 0 ? args.model : undefined;

    // Create an ephemeral session for this sub-agent
    let session;
    try {
      session = await sessionStore.create("sub-agent task");
    } catch (error) {
      return err(`task: failed to create sub-agent session: ${(error as Error).message}`);
    }

    // Add the user's prompt as a session message
    try {
      await sessionStore.addMessage(session.id, {
        role: "user",
        content: prompt,
      });
    } catch {
      // Non-fatal: we still send the prompt directly in the request
    }

    // Resolve provider configuration
    let registry: ProviderRegistry;
    let defaultModel: string;
    try {
      const resolved = await resolveProviderRegistry(context.cwd);
      registry = resolved.registry;
      defaultModel = resolved.defaultModel;
    } catch (error) {
      return err(`task: failed to resolve provider config: ${(error as Error).message}`);
    }

    const model = modelOverride ?? defaultModel;

    if (!model || model.length === 0) {
      return err(
        "task: no LLM provider configured. Set up a provider in your c0de config " +
          "(~/.c0de/config.json or .c0de/config.json) or specify a model override.\n\n" +
          "Example config:\n" +
          '  {\n    "providers": [\n      { "_tag": "openai", "apiKey": "sk-..." }\n    ],\n' +
          '    "defaultProvider": "openai",\n    "defaultModel": "gpt-4o"\n  }',
      );
    }

    // Build the chat request
    const messages: ChatMessage[] = [
      { role: "system", content: buildSubAgentSystemPrompt() },
      { role: "user", content: prompt },
    ];

    const request: ChatRequest = {
      model,
      messages,
      stream: true,
      maxTokens: 8192,
      temperature: 0.7,
    };

    if (SUB_AGENT_TOOLS.length > 0) {
      request.tools = SUB_AGENT_TOOLS;
    }

    // Call the LLM and collect the response
    try {
      const stream = chatStream(registry, request);
      const output = await collectStreamOutput(stream, context.abort);

      if (output.length === 0) {
        return err("task: sub-agent returned empty output");
      }

      return ok(output.trim(), {
        model,
        sessionId: session.id,
      });
    } catch (error) {
      // Check for provider-not-found vs LLM errors
      const msg = (error as Error).message;
      if (msg.includes("not found") || msg.includes("no provider")) {
        return err(
          `task: provider for model "${model}" not found. ` +
            "Ensure your config has a matching provider section.",
        );
      }
      return err(`task: sub-agent failed: ${msg}`);
    }
  },
};
