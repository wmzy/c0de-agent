import { buildDynamicPrompt, createPromptRegistry } from './prompt-registry.js'
import type { PromptContext } from './types.js'

/**
 * Build the system prompt for an agent run.
 *
 * Legacy entry point kept for backward compatibility with `agentLoop` and
 * existing call sites. Internally assembles via the dynamic prompt registry
 * (spec §17): a default registry seeded with the built-in sections, so plugins
 * that register custom sections on the same registry are reflected.
 */
function buildSystemPrompt(ctx: PromptContext): string {
  return buildDynamicPrompt(createPromptRegistry(), ctx)
}

export { buildSystemPrompt }
