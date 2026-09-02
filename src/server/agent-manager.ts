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
  pause(sessionId: string): boolean
  resume(sessionId: string): boolean
  steer(sessionId: string, message: string): boolean
  /** 查询某 session 的所有子 agent run（恢复/展示用）。 */
  children(parentSessionId: string): ActiveRun[]
  /** 查询所有后台任务（jobId 非空的 run）。 */
  backgroundJobs(): ActiveRun[]
  /** 中止所有活跃 run 并清空（dev 热重载重建前调用）。 */
  dispose(): void
}

/** 取 slot 内的活跃 run；占位（'starting'）或不存在返回 undefined。 */
function slotRun(slot: RunSlot | undefined): ActiveRun | undefined {
  return slot?.kind === 'run' ? slot.run : undefined
}

function createAgentManager(): AgentManager {
  const runs = new Map<string, RunSlot>()

  return {
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
    pause(sessionId) {
      const run = slotRun(runs.get(sessionId))
      if (!run) return false
      pauseAgent(run.state)
      return true
    },
    resume(sessionId) {
      const run = slotRun(runs.get(sessionId))
      if (!run) return false
      resumeAgent(run.state)
      return true
    },
    steer(sessionId, message) {
      const run = slotRun(runs.get(sessionId))
      if (!run) return false
      injectSteering(run.state, message)
      return true
    },
    children(parentSessionId) {
      return Array.from(runs.values())
        .map((slot) => slotRun(slot))
        .filter((r): r is ActiveRun => r?.parentSessionId === parentSessionId)
    },
    backgroundJobs() {
      return Array.from(runs.values())
        .map((slot) => slotRun(slot))
        .filter((r): r is ActiveRun => r?.jobId !== undefined)
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
}

export type { ActiveRun, AgentManager }
export { createAgentManager }
