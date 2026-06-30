import type { ToolDef } from '../../shared/types/tool.js'

/**
 * yield 工具：子 agent 专用，提交结构化最终结果。
 *
 * 这是子 agent 返回结果的唯一方式。调用后，runSubAgent 的 collectYield
 * 回调收集结果，子 agent loop 检测到 yield 后优雅终止。
 * 主 agent 不注册此工具。permission: auto（纯结果收集，不改外部状态）。
 */
export const yieldTool: ToolDef = {
  name: 'yield',
  description:
    'Submit your final structured result. This is the ONLY way to return a result from a sub-agent task. Call this once when your work is complete.',
  parameters: {
    type: 'object',
    properties: {
      data: {
        type: 'object',
        description:
          'Your structured result. Must match the outputSchema if the agent declared one.',
      },
      type: {
        type: 'string',
        description: 'Optional section label for incremental yields.',
      },
      status: {
        type: 'string',
        enum: ['success', 'aborted'],
        description: 'Outcome status. Use "aborted" if blocked.',
      },
      error: {
        type: 'string',
        description: 'If blocked (status=aborted), describe what you tried and the exact blocker.',
      },
    },
    required: ['data'],
  },
  permission: 'auto',
  execute: async (input: unknown, ctx) => {
    const { data } = input as { data: unknown }
    ctx.collectYield?.(data)
    return { _tag: 'success', output: 'Result submitted.' }
  },
}
