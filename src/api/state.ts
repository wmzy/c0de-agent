// Module-level state shared across route modules.
//
// Active agents keyed by sessionId. Pending tool confirmations keyed by
// toolCallId. Paused state per session.

import { abortAgent, createAgent } from "../agent";
import type { AgentConfig, AgentState } from "../agent";
import { resolveAgentConfig } from "../core";
import type { ServerDeps } from "./index";

export type ActiveAgent = {
  state: AgentState;
  config: AgentConfig;
  /** Resolve function for a pending permission confirm. */
  pendingConfirm: Map<
    string,
    {
      resolve: (confirmed: boolean) => void;
      tool: string;
      input: unknown;
    }
  >;
  paused: boolean;
};

export const activeAgents = new Map<string, ActiveAgent>();

/**
 * Get or create an active agent for the given session. The agent config is
 * derived from the current merged config + session-specific overrides.
 */
export async function getOrCreateAgent(deps: ServerDeps, sessionId: string): Promise<ActiveAgent> {
  const existing = activeAgents.get(sessionId);
  if (existing) return existing;

  const agentConfig: AgentConfig = {
    ...resolveAgentConfig(deps.config),
    providerRegistry: deps.providerRegistry,
    toolRegistry: deps.toolRegistry,
    workingDirectory: deps.workingDirectory,
    sessionId,
  };

  const state = createAgent(agentConfig);
  const agent: ActiveAgent = {
    state,
    config: agentConfig,
    pendingConfirm: new Map(),
    paused: false,
  };

  activeAgents.set(sessionId, agent);
  return agent;
}

/**
 * Wait for a tool confirmation from the frontend. Returns a promise that
 * resolves to `true` if confirmed, `false` if denied.
 */
export function waitForConfirm(agent: ActiveAgent, toolCallId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const pending = agent.pendingConfirm.get(toolCallId);
    if (pending) {
      pending.resolve = resolve;
    } else {
      // Shouldn't happen, but resolve as denied if not found.
      resolve(false);
    }
  });
}

/**
 * Clean up an active agent and resolve all pending confirms as denied.
 */
export function cleanupAgent(sessionId: string): void {
  const agent = activeAgents.get(sessionId);
  if (!agent) return;
  abortAgent(agent.state);
  for (const [, pending] of Array.from(agent.pendingConfirm)) {
    pending.resolve(false);
  }
  activeAgents.delete(sessionId);
}
