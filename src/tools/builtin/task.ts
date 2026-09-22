import type {
  SubAgentRequest,
  SubAgentResult,
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
          // 缺 assignment 的条目此前静默派出 prompt=undefined 的子 agent
          // （headChars 抛 TypeError / 烧一轮内容为 "undefined" 的 LLM 调用）——
          // 逐条目显式必填，错误信息可指导模型修正。
          required: ['assignment'],
        },
        description: 'Parallel sub-tasks (batch mode).',
      },
    },
    // 单任务（prompt）与批量（context+tasks）二选一。不能与顶层
    // required:['prompt'] 并存：anyOf 与兄弟关键字是合取关系，顶层 required
    // 会让批量形态恒校验失败。
    anyOf: [{ required: ['prompt'] }, { required: ['context', 'tasks'] }],
  },
  permission: 'auto',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    // 单任务入口（ctx.runSubAgent）与批量入口（ctx.runSubAgents）二选一即可工作：
    // 批量入口存在时批量模式走宿主的并发池，否则回退逐个派发。
    const runOne = ctx.runSubAgent
    const runBatch = ctx.runSubAgents
    if (!runOne && !runBatch) {
      return {
        _tag: 'error',
        error: 'task tool unavailable: no sub-agent runner is wired into this context',
      }
    }

    const inp = input as TaskInput

    // 运行时形状校验（schema 兜底之外的执行层防线——execute 可绕过 executor
    // 校验被直接调用）。此前 tasks 条目缺 assignment / 空 tasks 数组会静默
    // 落回单任务模式，把 prompt=undefined 派给子 agent（headChars 处 TypeError
    // 或烧一轮内容为 "undefined" 的 LLM 调用），模型只拿到晦涩报错。
    const tasksInput: unknown = 'tasks' in inp ? inp.tasks : undefined
    if (tasksInput !== undefined && !Array.isArray(tasksInput)) {
      return {
        _tag: 'error',
        error: 'task: tasks must be an array of { assignment, description?, role? }',
      }
    }
    const batchTasks: TaskItem[] = Array.isArray(tasksInput) ? (tasksInput as TaskItem[]) : []
    for (let i = 0; i < batchTasks.length; i++) {
      const item = batchTasks[i] as { assignment?: unknown } | null | undefined
      if (
        item === null ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        typeof item.assignment !== 'string' ||
        item.assignment.trim().length === 0
      ) {
        return {
          _tag: 'error',
          error: `task: tasks[${i}] is missing a non-empty string "assignment" (the sub-agent prompt). Expected batch item shape: { assignment, description?, role? }`,
        }
      }
    }

    // 批量模式
    if ('tasks' in inp && batchTasks.length > 0) {
      const agentType =
        typeof inp.subagent_type === 'string' && inp.subagent_type.length > 0
          ? inp.subagent_type
          : 'general'
      const requests: SubAgentRequest[] = batchTasks.map((item) => ({
        agentType,
        prompt: item.assignment,
        ...(typeof item.description === 'string' && item.description.length > 0
          ? { description: item.description }
          : {}),
        ...(typeof item.role === 'string' && item.role.length > 0 ? { role: item.role } : {}),
        ...(typeof inp.context === 'string' && inp.context.length > 0
          ? { context: inp.context }
          : {}),
      }))
      // 并发派发：工具描述承诺 "Launch multiple agents concurrently"，宿主批量入口
      // 按 config.agents.subagentConcurrency 建并发池。此前无论宿主是否提供批量能力
      // 都逐个 await——N 个子 agent 的墙钟时间线性叠加，并发配置形同虚设。
      // 宿主未注入批量入口时回退逐个派发（结果顺序不变，仅串行）。
      const results: SubAgentResult[] = []
      if (runBatch) {
        results.push(...(await runBatch(requests)))
      } else if (runOne) {
        for (const req of requests) results.push(await runOne(req))
      }
      const label = (i: number): string => inp.tasks[i]?.description ?? inp.tasks[i]?.role ?? 'task'
      const completed: string[] = []
      const failures: string[] = []
      results.forEach((res, i) => {
        if (res._tag === 'error') {
          failures.push(`[${label(i)}] ${res.error}`)
          return
        }
        if (res._tag === 'running') {
          completed.push(`[${label(i)}] background started (jobId: ${res.jobId})`)
          return
        }
        completed.push(`[${label(i)}] ${res.output}`)
      })
      if (failures.length > 0) {
        // 失败不吞掉已完成任务的结果：模型据此只重派失败的子任务
        return {
          _tag: 'error',
          error:
            `Sub-agent failed: ${failures.join('; ')}` +
            (completed.length > 0 ? `\n\nCompleted:\n${completed.join('\n\n')}` : ''),
        }
      }
      return { _tag: 'success', output: completed.join('\n\n') }
    }

    // 单任务模式
    const single = inp as SingleTaskInput
    // 空 tasks 数组等形态会落进单任务分支：prompt 非非空字符串显式报错，
    // 绝不把 undefined 派给子 agent。
    if (typeof single.prompt !== 'string' || single.prompt.trim().length === 0) {
      return {
        _tag: 'error',
        error:
          'task: prompt must be a non-empty string (single mode) — for batch mode provide context + tasks[] where every item has a non-empty "assignment"',
      }
    }
    const agentType =
      typeof single.subagent_type === 'string' && single.subagent_type.length > 0
        ? single.subagent_type
        : 'general'
    const req: SubAgentRequest = {
      agentType,
      prompt: single.prompt,
      ...(typeof single.description === 'string' && single.description.length > 0
        ? { description: single.description }
        : {}),
      ...(typeof single.model === 'string' && single.model.length > 0
        ? { model: single.model }
        : {}),
      ...(single.background === true ? { background: true } : {}),
    }
    if (!runOne) {
      return {
        _tag: 'error',
        error:
          'task tool unavailable: single-task mode requires a sub-agent runner (ctx.runSubAgent)',
      }
    }
    const result = await runOne(req)
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
