import { appendMessage } from '../../session/message.js'
import { createSession, updateSessionLastRun } from '../../session/session.js'
import { generateId } from '../../shared/index.js'
import type { AgentState } from '../../shared/types/agent.js'
import type { JSONSchema } from '../../shared/types/base.js'
import type { Session } from '../../shared/types/message.js'
import type { SubAgentRequest, SubAgentResult } from '../../shared/types/tool.js'
import { headChars } from '../../shared/utils/string.js'
import { validateInput } from '../../tools/validate.js'
import { abortAgent, createAgent, runAgent } from '../agent.js'
import { mapWithConcurrencyLimit } from '../agents/parallel.js'
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
    `Sub-agent (${request.agentType}): ${headChars(request.prompt, 60)}`
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
      undefined,
      undefined,
      deps.hookRunner,
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
  // P1/P2-5：子 agent 工具集无条件取交集（def.tools ∩ 父工具集）——父工具集
  // 已统一为 resolveEnabledToolNames 的配置解析结果（chat 主 run、CLI print、
  // 工作流 runner 三处同口径），config.tools.enabled 的 fail-closed 语义对一切
  // 派生路径成立：全禁时交集为空，子 agent 仅持 yield，写/执行能力不再被
  // def 固定名单绕过。此前 length>0 例外为工作流 runner 恒 tools=[] 而设，
  // 子 agent 因而拿到全套固定名单——现 runner 传解析结果，例外不再需要。
  const declaredTools = def.tools
    ? def.tools.filter((t) => parent.config.tools.includes(t))
    : parent.config.tools
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

  // 子 agent 的 deps：覆盖 cwd（worktree）+ 注入 yield 收集器 + 递归深度。
  // yield 收集器对 def.outputSchema 做 JSON Schema 校验（spec: multi-agent-design
  // §4.5 声明但从未消费）：不合法抛错 → yield 工具折成 error 反馈给模型，模型可
  // 修正后重试；合法才入收集数组（最终作为 task 结果 data 回传父 agent）。
  const childDeps: LoopDeps = {
    ...deps,
    cwd: childCwd,
    _subagentYieldCollector: (data: unknown) => {
      if (def.outputSchema) {
        const result = validateInput(def.outputSchema as JSONSchema, data)
        if (!result.valid) {
          throw new Error(
            `yield data does not match the agent's outputSchema: ${result.error}. ` +
              'Call yield again with data that satisfies the schema.',
          )
        }
      }
      yielded.push(data)
    },
    _subagentDepth: childDepth,
  }

  const childState = await createAgent(childSession, childConfig, childDeps)
  // 继承父 agent 的「预算已确认超支」标记：父 run 已因预算暂停、用户点「恢复」
  // 继续后，子 agent 不应再因同一预算超支提前中止（用户已知情继续）；父未超支
  // 时标记为 undefined，子 agent 自跑其 loop 仍会按轮次独立检查预算。
  childState.budgetPauseTriggered = parent.budgetPauseTriggered

  // abort 链接：父 abort 则子 abort。
  // 必须走 abortAgent（= abort signal + 把 running/paused 清成 stopped）而非裸
  // abortController.abort()：子 run 可能正停在暂停点（权限超时/预算暂停会级联暂停
  // 子 run），signal-only 中止不清 status，子 loop 的暂停等待永远不返回——子 run
  // 槽位泄漏、父 run 的工具批次（task 工具 await）永不返回。
  // 监听器在子 run 结束时摘除（见 runBody 的 finally）：{ once: true } 只在真的
  // 触发 abort 时自动摘除，正常完成的子 run（绝大多数）从不触发——父 run 级
  // signal 上每派发一个子 agent 就留一个监听器，累积到 11 个即触发 Node 的
  // MaxListenersExceededWarning，闭包也随 signal 活到父 run 结束。
  const onParentAbort = (): void => abortAgent(childState)
  if (parent.abortController.signal.aborted) {
    abortAgent(childState)
  } else {
    parent.abortController.signal.addEventListener('abort', onParentAbort, { once: true })
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
      // 子 run 结束即摘除父 signal 上的 abort 联动监听器（background 路径在此前
      // 一直保留——子 run 仍在跑时父 abort 必须仍能级联，故只能在此摘除）。
      parent.abortController.signal.removeEventListener('abort', onParentAbort)
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
/** 子 agent 并发上限的默认值与上限。
 *  配置项 config.agents.subagentConcurrency 经 normalizeSubagentConcurrency 归一化；
 *  上限 10 防配置面（手改/克隆仓库自带）把并发推到宿主无法承受（每个子 agent 都是
 *  独立 session + LLM 调用 + DB 写）。 */
const DEFAULT_SUBAGENT_CONCURRENCY = 3
const MAX_SUBAGENT_CONCURRENCY = 10

/** 归一化子 agent 并发上限：缺失/非有限/<1 回落默认 3，上限钳到 10。
 *  与 ToolDef.timeout / clampTimerDelay 同口径——配置面的退化值不得让派发失控
 *  （0 或负数会让并发池退化成「一个都不跑」）。 */
export function normalizeSubagentConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return DEFAULT_SUBAGENT_CONCURRENCY
  }
  return Math.min(Math.trunc(value), MAX_SUBAGENT_CONCURRENCY)
}

/** 单任务派发函数（批量派发的注入点：工作流宿主自带 runner 时无需经 deps 组装）。 */
type SubAgentRunner = (request: SubAgentRequest) => Promise<SubAgentResult>

/**
 * 批量派发子 agent（task 工具批量模式 / 工作流 ctx.runSubagents 共用）。
 *
 * - 并发上限取 config.agents.subagentConcurrency（默认 3）——此前 task 工具批量模式
 *   逐个 await（墙钟时间线性叠加，与工具描述的 "Launch multiple agents concurrently"
 *   相悖），工作流侧则硬编码 3（配置项形同虚设）。
 * - 结果与入参顺序一一对应，绝不出现空洞：未启动的任务（abort）填 error 结果，
 *   调用方无需再处理 undefined。
 * - 单个任务失败隔离（抛错/error 结果都收敛为 error），不 fail-fast 终止兄弟任务。
 * - abort（父 run 中止）取消尚未启动的任务。
 */
export async function runSubAgents(
  deps: LoopDeps,
  parent: AgentState,
  requests: SubAgentRequest[],
  runOne: SubAgentRunner = (request) => runSubAgent(deps, parent, request),
): Promise<SubAgentResult[]> {
  if (requests.length === 0) return []
  const limit = normalizeSubagentConcurrency(deps.config.agents?.subagentConcurrency)
  const { results } = await mapWithConcurrencyLimit(
    requests,
    limit,
    async (request) => {
      try {
        return await runOne(request)
      } catch (e) {
        // 隔离单个任务的异常：不向上抛，避免 fail-fast 终止尚未启动的兄弟任务
        return { _tag: 'error' as const, error: e instanceof Error ? e.message : String(e) }
      }
    },
    parent.abortController.signal,
  )
  return results.map(
    (result, i): SubAgentResult =>
      result ?? { _tag: 'error', error: `sub-agent task ${i + 1} was not started (run aborted)` },
  )
}
