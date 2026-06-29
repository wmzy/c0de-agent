// src/server/agent-manager.ts
import { abortAgent, injectSteering, pauseAgent, resumeAgent } from '../core/index.js'
import type { AgentDependencies } from '../core/types.js'
import type { AgentState } from '../shared/types/agent.js'

/** 一个活跃的 agent run。 */
type ActiveRun = {
  sessionId: string
  state: AgentState
  deps: AgentDependencies
}

/** Agent run 跟踪器 + 控制操作。 */
type AgentManager = {
  register(run: ActiveRun): void
  get(sessionId: string): ActiveRun | undefined
  unregister(sessionId: string): void
  size(): number
  abort(sessionId: string): boolean
  pause(sessionId: string): boolean
  resume(sessionId: string): boolean
  steer(sessionId: string, message: string): boolean
}

function createAgentManager(): AgentManager {
  const runs = new Map<string, ActiveRun>()

  return {
    register(run) {
      runs.set(run.sessionId, run)
    },
    get(sessionId) {
      return runs.get(sessionId)
    },
    unregister(sessionId) {
      runs.delete(sessionId)
    },
    size() {
      return runs.size
    },
    abort(sessionId) {
      const run = runs.get(sessionId)
      if (!run) return false
      abortAgent(run.state)
      return true
    },
    pause(sessionId) {
      const run = runs.get(sessionId)
      if (!run) return false
      pauseAgent(run.state)
      return true
    },
    resume(sessionId) {
      const run = runs.get(sessionId)
      if (!run) return false
      resumeAgent(run.state)
      return true
    },
    steer(sessionId, message) {
      const run = runs.get(sessionId)
      if (!run) return false
      injectSteering(run.state, message)
      return true
    },
  }
}

export type { ActiveRun, AgentManager }
export { createAgentManager }
