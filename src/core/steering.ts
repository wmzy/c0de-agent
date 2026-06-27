import type { AgentState } from '../shared/types/agent.js'

/** Add a steering message to the queue. Takes effect before the next LLM turn. */
function injectSteering(state: AgentState, message: string): void {
  state.steeringQueue.push(message)
}

/** Remove and return all queued steering messages (FIFO order). Clears the queue. */
function drainSteering(state: AgentState): string[] {
  const messages = [...state.steeringQueue]
  state.steeringQueue.length = 0
  return messages
}

/** Discard all queued steering messages without returning them. */
function clearSteering(state: AgentState): void {
  state.steeringQueue.length = 0
}

export { clearSteering, drainSteering, injectSteering }
