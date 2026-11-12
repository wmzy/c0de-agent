// src/server/routes/todo.ts
import { Hono } from 'hono'
import { appendMessage, getMessages } from '../../session/message.js'
import { generateId } from '../../shared/index.js'
import type { MessageContent } from '../../shared/types/message.js'
import type { TodoPhaseLike } from '../../shared/types/tool.js'
import {
  formatSummary,
  getLatestTodoPhasesFromMessages,
  type TodoPhase,
  todoTool,
} from '../../tools/builtin/todo.js'
import { validateInput } from '../../tools/validate.js'
import { apiError } from '../middleware/error.js'
import { uuidParamGuard } from '../middleware/uuid-param.js'
import type { ServerContext } from '../types.js'
import { readJsonObject } from '../util/json-body.js'
import { getLiveSessionOr404 } from './chat.js'

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

/** 恢复当前 todo phases：活跃 agent 直接读内存态，无活跃 agent 从历史消息
 *  重建（GET 读取与 POST 手动操作共用同一恢复口径）。附带返回 run 句柄供
 *  POST 写回内存态（GET 忽略）。 */
async function loadPhases(
  ctx: ServerContext,
  sessionId: string,
): Promise<{ phases: TodoPhase[]; run: ReturnType<ServerContext['agentManager']['get']> }> {
  const run = ctx.agentManager.get(sessionId)
  if (run) return { phases: run.state.todoPhases as TodoPhase[], run }
  const messages = await getMessages(ctx.db, sessionId)
  return { phases: getLatestTodoPhasesFromMessages(messages), run: undefined }
}

function createTodoRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // 路径参数 sessionId 是 sessions.id（uuid 列）：非 UUID 直接 404（守卫语义
  // 收敛到 middleware/uuid-param.ts，此处只声明参数名与文案）。
  app.use('/:sessionId', uuidParamGuard('sessionId', 'NOT_FOUND', '会话不存在或已删除'))

  // GET /:sessionId — 获取当前 todo 状态
  app.get('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const { phases } = await loadPhases(ctx, sessionId)
    return c.json({ phases })
  })

  // POST /:sessionId — 执行一个 todo 操作（UI 手动操作入口）
  app.post('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const parsed = await readJsonObject(c)
    if (!parsed.ok) return parsed.response
    const body = parsed.body

    // 校验 session 存在且未进回收站（写端点 requireLive 口径）：回收站会话
    // 此前只查 !session，仍可执行 todo 操作并 appendMessage 持久化——
    // 收敛到 getLiveSessionOr404 与其他会话写端点同源。
    const live = await getLiveSessionOr404(ctx, c, sessionId)
    if (!live.ok) return live.response

    // 与工具执行管线同口径校验入参：本路由绕过 executor 直调 todoTool.execute，
    // 此前畸形 body（list 非数组 → initPhases 对字符串 for-of 后 .map TypeError 500；
    // items 含非字符串 → 毒化状态原样持久化）无任何校验。非法显式 400 让前端可操作。
    const validation = validateInput(todoTool.parameters, body)
    if (!validation.valid) {
      return apiError(c, 400, 'INVALID_TODO_INPUT', `无效的 todo 操作参数：${validation.error}`)
    }

    // 恢复当前 phases（run 句柄留给成功后的内存态写回）
    const { phases: currentPhases, run } = await loadPhases(ctx, sessionId)

    // 执行 todo 操作
    const todoCtx = makeTodoCtx(currentPhases, c.req.raw.signal)
    const result = await todoTool.execute(body, todoCtx)

    // 从 todoState 读取操作后的 phases
    const updatedPhases = todoCtx.todoState.get() as TodoPhase[]

    // 如果操作成功且 phases 有变化，持久化为 tool 消息
    if (result._tag === 'success' && body.op !== 'view') {
      // tool_call 与 tool_result 必须共用同一个 id：前端 normalizeParts 按 id 配对，
      // 两个 generateId() 会让它们配不上——时间线上留下一个永远停在「运行中」
      // （⏳ 永不结束）的 todo 块，正文还因拿不到 output 而谎报「Todo list is empty.」，
      // 另加一张孤立的 result 卡。实测从「任务本会话待办」面板点「添加」后必现。
      const toolMessageId = generateId()
      // 构造 tool_result 消息内容
      const toolResultContent: MessageContent = {
        _tag: 'tool_result',
        id: toolMessageId,
        tool: 'todo',
        output: {
          _tag: 'success' as const,
          output: result.output,
          metadata: result.metadata,
        },
      }
      const toolCallContent: MessageContent = {
        _tag: 'tool_call',
        id: toolMessageId,
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
