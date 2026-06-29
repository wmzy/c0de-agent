import type { ToolDef, ToolResult } from '../../shared/types/tool.js'

type TaskInput = {
  prompt: string
  description?: string
  model?: string
}

/**
 * task tool: spawn a sub-agent to work on a delegated prompt and return its
 * final text output. Permission: auto (sub-agents are isolated sessions and
 * cannot widen the parent agent's own permissions).
 *
 * Implementation is dependency-inverted (spec §12.3): the actual sub-agent run
 * is performed by the host (core's agent loop) via `ctx.runSubAgent`, so this
 * package does not import core (no tools→core cycle). When no runner is wired,
 * returns an error.
 */
export const taskTool: ToolDef = {
  name: 'task',
  description:
    'Spawn a sub-agent to work on a delegated prompt in an isolated session and return its final text output. Use for independent, parallelizable sub-tasks. The sub-agent has its own context window and message history.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The complete, self-contained assignment for the sub-agent.',
      },
      description: {
        type: 'string',
        description: 'Short human-readable label for the sub-agent (display only).',
      },
      model: {
        type: 'string',
        description: 'Optional model override for the sub-agent (defaults to the parent model).',
      },
    },
    required: ['prompt'],
  },
  permission: 'auto',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const { prompt, description, model } = input as TaskInput

    if (!ctx.runSubAgent) {
      return {
        _tag: 'error',
        error: 'task tool unavailable: no sub-agent runner is wired into this context',
      }
    }

    const result = await ctx.runSubAgent({ prompt, description, model })
    if (result._tag === 'error') {
      return { _tag: 'error', error: `Sub-agent failed: ${result.error}` }
    }
    return {
      _tag: 'success',
      output: result.output,
      metadata: { sessionId: result.sessionId },
    }
  },
}
