import type {
  SubAgentRequest,
  TaskItem,
  ToolDef,
  ToolResult,
} from '../../shared/types/tool.js'

/** 单任务输入。 */
type SingleTaskInput = {
  subagent_type?: string
  prompt: string
  description?: string
  model?: string
  background?: boolean
}

/** 批量任务输入。 */
type BatchTaskInput = {
  subagent_type: string
  context: string
  tasks: TaskItem[]
}

type TaskInput = SingleTaskInput | BatchTaskInput

/**
 * task 工具：按 agent 类型派发子 agent。
 *
 * 两种形态：单任务（subagent_type + prompt）或批量并行（subagent_type + context + tasks[]）。
 * 依赖反转：实际子 agent 运行由 host（core loop 的 runSubAgent）通过 ctx.runSubAgent 执行。
 * permission: auto（子 agent 是隔离 session，不扩宽父权限）。
 */
export const taskTool: ToolDef = {
  name: 'task',
  description:
    'Launch specialized sub-agents to handle delegated tasks. Specify subagent_type to select a specialist (e.g. researcher for read-only investigation, coder for implementation, reviewer for code review). Launch multiple agents concurrently by using the batch form with tasks[]. The sub-agent runs in an isolated session with its own context. When done, the sub-agent returns its result via the yield tool.',
  parameters: {
    type: 'object',
    properties: {
      subagent_type: {
        type: 'string',
        description:
          "The specialist agent type (e.g. researcher, coder, reviewer). Defaults to 'general'.",
      },
      description: { type: 'string', description: 'Short label for the task (display only).' },
      prompt: { type: 'string', description: 'Self-contained assignment (single-task mode).' },
      model: { type: 'string', description: 'Optional model override.' },
      background: { type: 'boolean', description: 'Run in background (default false).' },
      context: { type: 'string', description: 'Shared context (batch mode).' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            role: { type: 'string', description: 'Specialist role for this sub-task.' },
            assignment: { type: 'string' },
          },
        },
        description: 'Parallel sub-tasks (batch mode).',
      },
    },
    required: ['prompt'],
    anyOf: [{ required: ['prompt'] }, { required: ['context', 'tasks'] }],
  },
  permission: 'auto',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    if (!ctx.runSubAgent) {
      return {
        _tag: 'error',
        error: 'task tool unavailable: no sub-agent runner is wired into this context',
      }
    }

    const inp = input as TaskInput

    // 批量模式
    if ('tasks' in inp && Array.isArray(inp.tasks) && inp.tasks.length > 0) {
      const agentType = inp.subagent_type ?? 'general'
      const results: string[] = []
      for (const item of inp.tasks) {
        const req: SubAgentRequest = {
          agentType,
          prompt: item.assignment,
          ...(item.description ? { description: item.description } : {}),
          ...(item.role ? { role: item.role } : {}),
          ...(inp.context ? { context: inp.context } : {}),
        }
        const res = await ctx.runSubAgent(req)
        if (res._tag === 'error') {
          return { _tag: 'error', error: `Sub-agent failed: ${res.error}` }
        }
        const label = item.description ?? item.role ?? 'task'
        if (res._tag === 'running') {
          results.push(`[${label}] background started (jobId: ${res.jobId})`)
        } else {
          results.push(`[${label}] ${res.output}`)
        }
      }
      return { _tag: 'success', output: results.join('\n\n') }
    }

    // 单任务模式
    const single = inp as SingleTaskInput
    const req: SubAgentRequest = {
      agentType: single.subagent_type ?? 'general',
      prompt: single.prompt,
      ...(single.description ? { description: single.description } : {}),
      ...(single.model ? { model: single.model } : {}),
      ...(single.background ? { background: true } : {}),
    }
    const result = await ctx.runSubAgent(req)
    if (result._tag === 'error') {
      return { _tag: 'error', error: `Sub-agent failed: ${result.error}` }
    }
    if (result._tag === 'running') {
      return {
        _tag: 'success',
        output: `Background task started (jobId: ${result.jobId}). You will be notified on completion.`,
        metadata: { sessionId: result.sessionId, background: true, jobId: result.jobId },
      }
    }
    return {
      _tag: 'success',
      output: result.output,
      metadata: { sessionId: result.sessionId, ...(result.data ? { data: result.data } : {}) },
    }
  },
}
