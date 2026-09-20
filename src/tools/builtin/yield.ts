import type { ToolDef, ToolResult } from '../../shared/types/tool.js'

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
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const { data } = input as { data: unknown }
    // collectYield 由宿主实现（runSubAgent）——宿主在收集时对 outputSchema 做
    // 校验并抛错。把校验失败折成 error ToolResult 回给模型：模型看到失败原因后
    // 可修正 data 重试，而非整个子 run 静默带上非法结果。
    try {
      ctx.collectYield?.(data)
    } catch (error) {
      return { _tag: 'error', error: error instanceof Error ? error.message : String(error) }
    }
    return { _tag: 'success', output: 'Result submitted.' }
  },
}
