// src/server/agent-manager.ts
import { abortAgent, injectSteering, pauseAgent, resumeAgent } from '../core/index.js'
import type { AgentDependencies } from '../core/types.js'
import type { AgentState } from '../shared/types/agent.js'

/** 一个活跃的 agent run。 */
type ActiveRun = {
  sessionId: string
  state: AgentState
  deps: AgentDependencies
  /** 若为子 agent run：记录父 sessionId（恢复时重建树）。 */
  parentSessionId?: string
  /** 子 agent 类型名（调试/展示用）。 */
  agentType?: string
  /** 后台任务 jobId（后台 subagent）。 */
  jobId?: string
}

/**
 * runs 表条目（P0-4）：'starting' 为 POST /api/chat 并发守卫 tryAcquire 写入的
 * 同步原子占位（run 的 state/deps 尚未构建，SSE 回调内 register 时填充）；
 * 'run' 为已注册的活跃 run。
 */
type RunSlot = { kind: 'starting' } | { kind: 'run'; run: ActiveRun }

/** Agent run 跟踪器 + 控制操作。 */
type AgentManager = {
  /**
   * 同步原子占位（P0-4 POST /api/chat 并发守卫）：sessionId 无条目时立即占位并返回
   * true；已有条目（占位或活跃 run）时返回 false。has+set 一气呵成、全程无 await，
   * 杜绝 check-then-act 竞态——此前守卫用 get 检查、真正注册在 SSE 回调内，中间隔
   * 多个 await，双发 POST 均通过守卫后后注册覆盖前者（runs.set），且先结束者在
   * finally unregister 时误删仍在跑的 run，abort/steer/pause 全部失效。
   * 占位由 register 填充、unregister 释放，二者均幂等。
   */
  tryAcquire(sessionId: string): boolean
  /** 注册活跃 run；若该 sessionId 已被 tryAcquire 占位则填充该占位。 */
  register(run: ActiveRun): void
  /** 取活跃 run；占位期间（register 前）返回 undefined，视为无活跃 run。 */
  get(sessionId: string): ActiveRun | undefined
  /** 该 sessionId 是否处于占位状态（tryAcquire 后、register 前）。 */
  isStarting(sessionId: string): boolean
  /** 释放条目（占位或活跃 run）；幂等。 */
  unregister(sessionId: string): void
  /** 活跃 run 数（不含占位）。 */
  size(): number
  abort(sessionId: string): boolean
  pause(sessionId: string, reason?: string): boolean
  resume(sessionId: string): boolean
  /** 中止某会话的主 run 及其全部子 agent run（删除会话/清理路径）。
   *  返回主 run 是否存在并被中止（子 run 无条件尝试，与旧内联循环一致）。 */
  abortCascade(sessionId: string): boolean
  /** 暂停主 run 并级联其全部子 agent run（用户暂停/权限超时兜底）——仅暂停
   *  主 run 会让子 agent 在用户认为「已暂停」时继续执行。reason 同时透传主与
   *  子 run（状态栏区分暂停来源）。返回主 run 是否暂停成功。 */
  pauseCascade(sessionId: string, reason?: string): boolean
  /** 恢复主 run 并级联其全部子 agent run——暂停时子 run 一并暂停，仅恢复主
   *  run 会让父的工具批次永远等待已暂停的子 agent（死锁）。 */
  resumeCascade(sessionId: string): boolean
  /** 暂停全部活跃 run 并等待到达安全点；超时强制中止（热更新前调用）。
   *  返回 pausedIds：成功暂停的会话 id 列表——调用方在后续步骤（spawn 等）
   *  失败时必须对其逐个 resume 回滚，避免更新失败连带冻结用户对话。 */
  pauseAll(
    timeoutMs?: number,
  ): Promise<{ paused: number; forcedAbort: number; pausedIds: string[] }>
  steer(sessionId: string, message: string): boolean
  /** 查询所有后台任务（jobId 非空的 run）。 */
  backgroundJobs(): ActiveRun[]
  /** 列出全部活跃 run（含子 agent）——热更新影响面展示用。
   *  status/currentTool（P2-9）：确认弹窗区分「正在执行工具、超时将被强杀」的
   *  run 与普通 running/paused run，用户可判断被中断的代价。 */
  listActive(): Array<{
    sessionId: string
    agentType?: string
    parentSessionId?: string
    status: 'running' | 'paused' | 'idle' | 'stopped' | 'interrupted'
    currentTool?: string
  }>
  /** 中止所有活跃 run 并清空（dev 热重载重建前调用）。 */
  dispose(): void
}

/** 取 slot 内的活跃 run；占位（'starting'）或不存在返回 undefined。 */
function slotRun(slot: RunSlot | undefined): ActiveRun | undefined {
  return slot?.kind === 'run' ? slot.run : undefined
}

/** 级联操作目标：主 run + 其全部直接子 agent run（按 parentSessionId 归集）。 */
function cascadeTargets(runs: Map<string, RunSlot>, sessionId: string): ActiveRun[] {
  const main = slotRun(runs.get(sessionId))
  const children = Array.from(runs.values())
    .map((slot) => slotRun(slot))
    .filter((r): r is ActiveRun => r?.parentSessionId === sessionId)
  return main ? [main, ...children] : children
}

function createAgentManager(): AgentManager {
  const runs = new Map<string, RunSlot>()

  const manager: AgentManager = {
    tryAcquire(sessionId) {
      if (runs.has(sessionId)) return false
      runs.set(sessionId, { kind: 'starting' })
      return true
    },
    register(run) {
      runs.set(run.sessionId, { kind: 'run', run })
    },
    get(sessionId) {
      return slotRun(runs.get(sessionId))
    },
    isStarting(sessionId) {
      return runs.get(sessionId)?.kind === 'starting'
    },
    unregister(sessionId) {
      runs.delete(sessionId)
    },
    size() {
      let n = 0
      for (const slot of runs.values()) {
        if (slot.kind === 'run') n += 1
      }
      return n
    },
    abort(sessionId) {
      const run = slotRun(runs.get(sessionId))
      if (!run) return false
      abortAgent(run.state)
      return true
    },
    pause(sessionId, reason) {
      const run = slotRun(runs.get(sessionId))
      if (!run) return false
      pauseAgent(run.state, reason)
      return true
    },
    resume(sessionId) {
      const run = slotRun(runs.get(sessionId))
      if (!run) return false
      resumeAgent(run.state)
      return true
    },
    abortCascade(sessionId) {
      const targets = cascadeTargets(runs, sessionId)
      let mainFound = false
      for (const t of targets) {
        // 委托公开 abort（而非内联 abortAgent）：级联与单点中止走同一路径，
        // 对 spy/子类实现保持同一可观察契约。
        if (manager.abort(t.sessionId) && t.sessionId === sessionId) mainFound = true
      }
      return mainFound
    },
    pauseCascade(sessionId, reason) {
      const targets = cascadeTargets(runs, sessionId)
      let mainFound = false
      for (const t of targets) {
        if (manager.pause(t.sessionId, reason) && t.sessionId === sessionId) mainFound = true
      }
      return mainFound
    },
    resumeCascade(sessionId) {
      const targets = cascadeTargets(runs, sessionId)
      let mainFound = false
      for (const t of targets) {
        if (manager.resume(t.sessionId) && t.sessionId === sessionId) mainFound = true
      }
      return mainFound
    },
    /**
     * 请求暂停所有活跃 run，等待其到达安全暂停点（当前原子操作完成后）。
     * 超时后对仍未暂停的 run 强制 abort（热更新不能无限等待）。
     * 返回 { paused: 已暂停数, forcedAbort: 超时中止数 }。
     */
    async pauseAll(timeoutMs = 30_000): Promise<{
      paused: number
      forcedAbort: number
      pausedIds: string[]
    }> {
      const active = Array.from(runs.values())
        .map((slot) => slotRun(slot))
        .filter((r): r is ActiveRun => r !== undefined && r.state.status._tag === 'running')
      for (const run of active) {
        pauseAgent(run.state)
      }
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const stillRunning = active.filter((r) => r.state.status._tag === 'running')
        if (stillRunning.length === 0) break
        await new Promise((res) => setTimeout(res, 100))
      }
      let forcedAbort = 0
      for (const run of active) {
        if (run.state.status._tag === 'running') {
          abortAgent(run.state)
          forcedAbort += 1
        }
      }
      const pausedIds = active
        .filter((r) => r.state.status._tag === 'paused')
        .map((r) => r.sessionId)
      return { paused: active.length - forcedAbort, forcedAbort, pausedIds }
    },
    steer(sessionId, message) {
      const run = slotRun(runs.get(sessionId))
      if (!run) return false
      injectSteering(run.state, message)
      return true
    },
    backgroundJobs() {
      return Array.from(runs.values())
        .map((slot) => slotRun(slot))
        .filter((r): r is ActiveRun => r?.jobId !== undefined)
    },
    listActive() {
      return Array.from(runs.values())
        .map((slot) => slotRun(slot))
        .filter((r): r is ActiveRun => r !== undefined)
        .map((r) => ({
          sessionId: r.sessionId,
          agentType: r.agentType,
          parentSessionId: r.parentSessionId,
          status: r.state.status._tag,
          currentTool: r.state.status._tag === 'running' ? r.state.status.currentTool : undefined,
        }))
    },
    dispose() {
      // dev 热重载重建前调用：中止所有活跃 run（loop 在 turn/流边界检测 signal
      // → unwind → 调用方 finally 持久化 + unregister），然后清空 Map。
      for (const slot of runs.values()) {
        const run = slotRun(slot)
        if (run) abortAgent(run.state)
      }
      runs.clear()
    },
  }

  return manager
}

export type { ActiveRun, AgentManager }
export { createAgentManager }
