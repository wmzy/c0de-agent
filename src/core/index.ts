// @c0de/core - Agent core loop, prompt, config, context management

export const VERSION = "0.0.1";

export type { AgentConfig, AgentContext, AgentEvent, AgentRunner } from "./types";
export { DEFAULT_SYSTEM_PROMPT } from "./prompts";
export { DefaultAgentRunner, createAgent } from "./agent";
