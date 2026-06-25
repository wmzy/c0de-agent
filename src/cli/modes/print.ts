// Print mode — one-shot agent execution (design spec §11.2).
//
// Creates a temporary agent, sends the user's message, collects all text
// deltas, and returns the complete response as a string. Used by `c0de chat`
// for quick questions and scriptable output.
//
// Data + functions: no class, no this, no enum.

import type { AgentConfig, Message } from "../../agent";
import { createAgent, runAgent } from "../../agent";
import type { Config } from "../../core/types";
import { createProviderRegistry } from "../../llm";
import { createDefaultRegistry } from "../../tools";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PrintOptions = {
  model?: string;
  format: "text" | "json";
  maxTokens?: number;
};

// ---------------------------------------------------------------------------
// formatAgentError — extract a human-readable message from an AgentError
// ---------------------------------------------------------------------------

function formatAgentError(error: import("../../core/types").AgentError): string {
  switch (error._tag) {
    case "aborted":
      return "Agent execution was aborted";
    case "llm_error":
      return error.message;
    case "tool_error":
      return error.message;
    case "permission_denied":
      return error.reason;
    case "compaction_error":
      return error.message;
    case "unknown":
      return error.message;
  }
}

// ---------------------------------------------------------------------------
// runPrintMode — execute a one-shot agent call and return the response
// ---------------------------------------------------------------------------

export async function runPrintMode(
  config: Config,
  message: string,
  opts: PrintOptions,
): Promise<string> {
  const providerRegistry = createProviderRegistry(config.providers);
  const toolRegistry = createDefaultRegistry();

  const agentConfig: AgentConfig = {
    provider: opts.model ?? config.defaultProvider,
    model: opts.model ?? config.defaultModel,
    maxTokens: opts.maxTokens ?? config.compaction.reserveTokens,
    tools: [],
    plugins: [],
    providerRegistry,
    toolRegistry,
    workingDirectory: process.cwd(),
  };

  const state = createAgent(agentConfig);

  const msg: Message = {
    id: crypto.randomUUID(),
    role: "user",
    content: message,
    createdAt: Date.now(),
  };

  let output = "";

  for await (const event of runAgent(state, msg, agentConfig)) {
    switch (event._tag) {
      case "text_delta":
        output += event.text;
        break;
      case "error": {
        const errMsg = formatAgentError(event.error);
        output += `\n[Error: ${errMsg}]`;
        break;
      }
      case "done":
        break;
    }
  }

  if (opts.format === "json") {
    return JSON.stringify({ output });
  }

  return output;
}
