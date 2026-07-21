// src/server/routes/todo.ts
import { Hono } from 'hono'
import { appendMessage, getMessages } from '../../session/message.js'
import { getSession } from '../../session/session.js'
import { generateId } from '../../shared/index.js'
import type { MessageContent } from '../../shared/types/message.js'
import type { TodoPhaseLike } from '../../shared/types/tool.js'
import {
  formatSummary,
  getLatestTodoPhasesFromMessages,
  type TodoPhase,
  todoTool,
} from '../../tools/builtin/todo.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

/** 构造仅供 todo tool execute 使用的最小 ToolContext。 */
function makeTodoCtx(phases: TodoPhase[], abort: AbortSignal) {
  let state = phases
  return {
    cwd: '/',
    session: { id: '', cwd: '/' },
    abort,
    todoState: {
      get: () => state,
      set: (p: TodoPhaseLike[]) => {
        state = p as TodoPhase[]
      },
    },
  }
}

function createTodoRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // GET /:sessionId — 获取当前 todo 状态
  app.get('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const run = ctx.agentManager.get(sessionId)
    let phases: TodoPhase[]

    if (run) {
      // 活跃 agent：直接从内存状态读取
      phases = run.state.todoPhases as TodoPhase[]
    } else {
      // 无活跃 agent：从历史消息恢复
      const messages = await getMessages(ctx.db, sessionId)
      phases = getLatestTodoPhasesFromMessages(messages)
    }

    return c.json({ phases })
  })

  // POST /:sessionId — 执行一个 todo 操作（UI 手动操作入口）
  app.post('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)

    // 校验 session 存在
    const session = await getSession(ctx.db, sessionId)
    if (!session) {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }

    // 恢复当前 phases
    const run = ctx.agentManager.get(sessionId)
    let currentPhases: TodoPhase[]
    if (run) {
      currentPhases = run.state.todoPhases as TodoPhase[]
    } else {
      const messages = await getMessages(ctx.db, sessionId)
      currentPhases = getLatestTodoPhasesFromMessages(messages)
    }

    // 执行 todo 操作
    const todoCtx = makeTodoCtx(currentPhases, c.req.raw.signal)
    const result = await todoTool.execute(body, todoCtx)

    // 从 todoState 读取操作后的 phases
    const updatedPhases = todoCtx.todoState!.get() as TodoPhase[]

    // 如果操作成功且 phases 有变化，持久化为 tool 消息
    if (result._tag === 'success' && (body as { op?: string }).op !== 'view') {
      // 构造 tool_result 消息内容
      const toolResultContent: MessageContent = {
        _tag: 'tool_result',
        id: generateId(),
        tool: 'todo',
        output: {
          _tag: 'success' as const,
          output: result.output,
          metadata: result.metadata,
        },
      }
      const toolCallContent: MessageContent = {
        _tag: 'tool_call',
        id: generateId(),
        tool: 'todo',
        input: body,
      }

      // 存储为一条 tool 消息（tool_call + tool_result 合并）
      await appendMessage(ctx.db, sessionId, {
        role: 'tool',
        content: [toolCallContent, toolResultContent],
      })

      // 更新活跃 agent 的内存状态
      if (run) {
        run.state.todoPhases = updatedPhases
        // 前端手动修改了 todo 状态 → 注入 steering 通知 LLM（通道 A）
        const summary = formatSummary(updatedPhases, [], true)
        run.state.steeringQueue.push(
          `<todo-state-external>\nA todo change was made externally (via UI).\n${summary}\n</todo-state-external>`,
        )
      }
    }

    return c.json({
      phases: updatedPhases,
      output:
        result._tag === 'success'
          ? result.output
          : result._tag === 'error'
            ? result.error
            : result._tag === 'permission_required'
              ? result.reason
              : 'truncated',
    })
  })

  return app
}

export { createTodoRoute }
