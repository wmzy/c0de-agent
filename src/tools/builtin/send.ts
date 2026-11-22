import type { ToolDef, ToolResult } from '../../shared/types/tool.js'

/**
 * send tool: deliver a steering message to another running agent.
 *
 * 语义（omp IRC 单进程子集）：消息进入目标 agent（主会话或 task 派发的子
 * agent run）的 steering 队列，在其下一个 turn 边界合入上下文——不打断
 * 目标正在执行的 turn（非打断 aside）。目标 agent 收到后可据此调整后续
 * 行为；模型不需要也不会等待回执（无 wait 语义，一期刻意不做兄弟等待）。
 *
 * Permission: auto——只注入一条提示消息，不产生任何副作用；目标 agent 的
 * 行为仍受其自身权限体系约束。
 */
export const sendTool: ToolDef = {
  name: 'send',
  description:
    'Send a steering message to another running agent (a sub-agent sessionId from a task tool result, or a sibling/main session id). The message is merged into the target agent context at its next turn boundary — it does not interrupt the current turn. Use it to course-correct a running sub-agent without aborting it.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Target session id (from the task tool result sessionId field).',
      },
      message: { type: 'string', description: 'Message to deliver to the target agent.' },
    },
    required: ['sessionId', 'message'],
  },
  permission: 'auto',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const { sessionId, message } = input as { sessionId: string; message: string }
    if (!ctx.steerAgent) {
      return { _tag: 'error', error: 'send: not available in this host (no run registry)' }
    }
    if (!sessionId || !message.trim()) {
      return { _tag: 'error', error: 'send: sessionId and non-empty message are required' }
    }
    const res = ctx.steerAgent(sessionId, message)
    if (!res.delivered) {
      return {
        _tag: 'error',
        error: `send: ${res.detail}`,
      }
    }
    return {
      _tag: 'success',
      output: `Delivered to ${sessionId}: message queued (applies at its next turn boundary). ${res.detail}`,
    }
  },
}
