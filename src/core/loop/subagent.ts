import { appendMessage } from '../../session/message.js'
import { createSession, updateSessionLastRun } from '../../session/session.js'
import { generateId } from '../../shared/index.js'
import type { AgentState } from '../../shared/types/agent.js'
import type { Session } from '../../shared/types/message.js'
import type { SubAgentRequest, SubAgentResult } from '../../shared/types/tool.js'
import { createAgent, runAgent } from '../agent.js'
import type { LoopDeps } from '../loop.js'
import type { RepoBaseline } from '../worktree.js'
import {
  applyPatchToParent,
  captureBaseline,
  captureDeltaPatch,
  createWorktree,
  removeWorktree,
} from '../worktree.js'

/** 运行一个按类型派发的子 agent（spec: multi-agent-design §4.5）。
 *
 *  Host 端实现：查 agentRegistry 获取 AgentDefinition → 创建隔离子 session（agentType 记录）
 *  → 构建子 agent（专属 prompt + 受限工具集 + yield）→ 运行到 yield 或完成 → 返回结果。
 *  发射 subagent_start/subagent_end 事件供父 agent 转发（spec §4.5 step 7）。
 *  abort 链接父→子。maxRecursion 控制子 agent 能否再递归派生 task（spec §4.5 step 4）。
 *  def.isolated 时在 git worktree 中运行，结束后把 delta 自动 apply 回父仓库（spec §4.6）。
 *  request.background 时 fork 异步运行，立即返回 running（spec §4.7）。 */
export async function runSubAgent(
  deps: LoopDeps,
  parent: AgentState,
  request: SubAgentRequest,
): Promise<SubAgentResult> {
  // 1. 查 agent 类型
  if (!deps.agentRegistry) {
    return { _tag: 'error', error: 'task tool unavailable: no agent registry is wired' }
  }
  const def = deps.agentRegistry.get(request.agentType)
  if (!def) {
    return {
      _tag: 'error',
      error: `Unknown agent type: ${request.agentType} is not a valid agent type`,
    }
  }

  const title =
    request.description?.trim() ||
    `Sub-agent (${request.agentType}): ${request.prompt.slice(0, 60)}`
  const childId = generateId()
  const yielded: unknown[] = []

  // 发射 subagent_start 事件（spec §4.5 step 7）
  deps._subagentEventSink?.({
    _tag: 'subagent_start',
    childId,
    agentType: request.agentType,
    description: request.description ?? '',
    background: request.background ?? false,
  })

  // 2. 创建子 session（记录 agentType；parentId 挂到父会话——树内嵌套、
  //    删除父会话时级联，不再是游离根节点）
  let childSession: Session
  try {
    childSession = await createSession(
      deps.db,
      title,
      parent.session.projectId ?? undefined,
      request.agentType,
      parent.session.source ?? undefined,
      parent.session.id,
    )
  } catch (e) {
    return { _tag: 'error', error: e instanceof Error ? e.message : String(e) }
  }

  // 3. worktree 隔离（isolated agent）：失败回退共享 cwd
  let worktreePath: string | undefined
  let baseline: RepoBaseline | undefined
  if (def.isolated) {
    try {
      baseline = await captureBaseline(deps.cwd)
      worktreePath = await createWorktree(deps.cwd, `subagent-${childSession.id}`)
    } catch (e) {
      console.warn(
        `[subagent] worktree creation failed, falling back to shared cwd: ${e instanceof Error ? e.message : e}`,
      )
    }
  }
  const childCwd = worktreePath ?? deps.cwd

  // 4. 构建子 agent 配置：工具集隔离 + 模型覆盖 + 递归限制 + yield
  const parentDepth = deps._subagentDepth ?? 0
  const childDepth = parentDepth + 1
  // P1 修复：def.tools 与父工具集取交集——此前 def 固定名单完全覆盖父的
  // 配置解析结果，config.tools.enabled 的 fail-closed 语义可被 coder 等
  // 子 agent 的固定工具集绕过（父会话禁写，子 agent 仍持 write/edit/bash）。
  // 例外：父 tools 为空（工作流运行器 parent 恒 tools=[]，工具集由工作流
  // 自身按 agent 类型派发）时不取交集，保持 def 固定名单。
  const declaredTools =
    def.tools && parent.config.tools.length > 0
      ? def.tools.filter((t) => parent.config.tools.includes(t))
      : (def.tools ?? parent.config.tools)
  const maxRec = def.maxRecursion ?? 0
  const baseTools = childDepth > maxRec ? declaredTools.filter((t) => t !== 'task') : declaredTools
  const childTools = Array.from(new Set([...baseTools, 'yield']))
  const childConfig = {
    ...parent.config,
    systemPrompt: def.systemPrompt,
    // 子 agent 走整段 systemPrompt 替换，清除父的 role override 避免干扰
    agentRolePrompt: undefined,
    tools: childTools,
    ...(def.model ? { model: def.model } : {}),
    ...(request.model ? { model: request.model } : {}),
  }

  // 子 agent 的 deps：覆盖 cwd（worktree）+ 注入 yield 收集器 + 递归深度
  const childDeps: LoopDeps = {
    ...deps,
    cwd: childCwd,
    _subagentYieldCollector: (data: unknown) => {
      yielded.push(data)
    },
    _subagentDepth: childDepth,
  }

  const childState = await createAgent(childSession, childConfig, childDeps)
  // 继承父 agent 的「预算已确认超支」标记：父 run 已因预算暂停、用户点「恢复」
  // 继续后，子 agent 不应再因同一预算超支提前中止（用户已知情继续）；父未超支
  // 时标记为 undefined，子 agent 自跑其 loop 仍会按轮次独立检查预算。
  childState.budgetPauseTriggered = parent.budgetPauseTriggered

  // abort 链接：父 abort 则子 abort
  if (parent.abortController.signal.aborted) {
    childState.abortController.abort()
  } else {
    parent.abortController.signal.addEventListener(
      'abort',
      () => childState.abortController.abort(),
      { once: true },
    )
  }

  // P1：把子 run（同步 + 后台）注册进宿主 run 跟踪器（Web=agentManager）。
  // 此前子 run 完全游离：暂停（权限超时/用户/预算）、热更新 pauseAll、
  // 删除父会话的中止级联、更新影响面列表全部绕过后台子 agent。
  // 注册必须先于 dispatch：background 路径「返回 running」时子 run 已可被控制。
  const unregisterChild = deps.registerChildRun?.({
    sessionId: childSession.id,
    parentSessionId: parent.session.id,
    ...(request.background ? { jobId: childSession.id } : {}),
    state: childState,
    deps: childDeps,
  })

  // 实际运行子 agent 的内部函数（sync 与 background 共用）。
  // 无论正常完成/出错/被中止，finally 中注销宿主注册，避免 run 槽位泄漏。
  const runBody = async (): Promise<SubAgentResult> => {
    try {
      return await runChildBody(childState, childDeps, childSession, title, baseline, worktreePath)
    } finally {
      unregisterChild?.()
    }
  }

  // 子 agent loop 执行体：运行 loop → worktree delta 回传 → 发射结束事件。
  const runChildBody = async (
    childState: AgentState,
    childDeps: LoopDeps,
    childSession: Session,
    title: string,
    baseline: RepoBaseline | undefined,
    worktreePath: string | undefined,
  ): Promise<SubAgentResult> => {
    // 运行子 agent loop
    const childPrompt = request.context
      ? `CONTEXT\n${request.context}\n\nASSIGNMENT\n${request.prompt}`
      : request.prompt
    const text: string[] = []
    let errMsg: string | null = null
    try {
      for await (const ev of runAgent(
        childState,
        [{ _tag: 'text', text: childPrompt }],
        childDeps,
      )) {
        if (ev._tag === 'text_delta') {
          text.push(ev.text)
        } else if (ev._tag === 'error') {
          const e = ev.error
          errMsg = e._tag === 'unexpected' || e._tag === 'provider' ? e.message : e._tag
        }
      }
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e)
    }

    // 5. worktree 回传：仅成功时把 delta apply 回父仓库（spec §4.6）；无论成败都清理 worktree
    if (baseline && worktreePath) {
      if (errMsg === null) {
        try {
          const patch = await captureDeltaPatch(worktreePath, baseline)
          await applyPatchToParent(deps.cwd, patch, `agent(isolated): ${title}`)
        } catch (e) {
          console.warn(`[subagent] worktree apply failed: ${e instanceof Error ? e.message : e}`)
        }
      }
      removeWorktree(deps.cwd, worktreePath)
    }

    const success = errMsg === null

    // 发射 subagent_end 事件（spec §4.5 step 7）
    deps._subagentEventSink?.({
      _tag: 'subagent_end',
      childId,
      agentType: request.agentType,
      success,
      ...(success ? { output: text.join('') } : {}),
    })

    if (errMsg !== null) {
      return { _tag: 'error', error: errMsg, sessionId: childSession.id }
    }
    const data = yielded.length > 0 ? (yielded.length === 1 ? yielded[0] : yielded) : undefined
    return {
      _tag: 'success',
      output: text.join(''),
      sessionId: childSession.id,
      ...(data !== undefined ? { data } : {}),
    }
  }

  // 6. background 模式：fork 异步运行，立即返回 running；完成时向父 session 注入合成通知
  if (request.background) {
    const jobId = childSession.id
    // P2：落库 running 标记——进程崩溃后 markDeadBackgroundJobs 可识别悬空任务
    // 并给父会话发失败通知（此前仅内存 jobId，重启即静默丢失）。
    // 此写 await 完成再返回：保证「返回 running」时 DB 已记录；同时避免与
    // 子 loop 的并发写入叠加。
    await updateSessionLastRun(deps.db, childSession.id, {
      status: 'running',
      agentName: request.agentType,
      startedAt: Date.now(),
    }).catch(() => {})
    void runBody()
      .then(async (result) => {
        // 无论成败都置 completed：任务已终结，状态体现在合成通知里。
        // 顺序 await（不并发发起）：PGLite WASM 对同实例并发查询会忙等，
        // 与 appendMessage 并发叠加曾导致 100% CPU 自旋（loop.test.ts 复现）。
        await updateSessionLastRun(deps.db, childSession.id, {
          status: 'completed',
          agentName: request.agentType,
          startedAt: Date.now(),
        }).catch(() => {})
        const success = result._tag === 'success'
        const output = success ? result.output : (result as { error: string }).error
        const tag = success ? 'task_result' : 'task_error'
        const synthetic = `<task id="${childSession.id}" state="${success ? 'completed' : 'failed'}">\n<${tag}>\n${output}\n</${tag}>\n</task>`
        await appendMessage(deps.db, parent.session.id, {
          role: 'user',
          content: [{ _tag: 'text', text: synthetic }],
        }).catch((e) => {
          // 通知消息持久化失败：任务已算完但父 session 收不到完成通知——记录避免静默丢失。
          console.warn(
            '[subagent] background 通知消息持久化失败:',
            e instanceof Error ? e.message : String(e),
          )
        })
      })
      .catch((e) => {
        // background 子 agent 执行或合成失败：父 session 永远收不到结果，记录避免静默丢失。
        console.warn(
          '[subagent] background 子 agent 执行失败:',
          e instanceof Error ? e.message : String(e),
        )
      })
    return { _tag: 'running', jobId, sessionId: childSession.id }
  }

  return runBody()
}
