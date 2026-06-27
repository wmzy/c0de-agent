import type { StreamEvent, Usage } from '../../schema/events.js'
import type { ContentBlockID, FinishReason } from '../../schema/ids.js'

type LifecycleState = {
  stepStarted: boolean
  text: Set<ContentBlockID>
  reasoning: Set<ContentBlockID>
}

const initial = (): LifecycleState => ({
  stepStarted: false,
  text: new Set(),
  reasoning: new Set(),
})

type Result = { state: LifecycleState; events: StreamEvent[] }

const ensureStepStart = (state: LifecycleState, events: StreamEvent[]): LifecycleState => {
  if (state.stepStarted) return state
  events.push({ type: 'step-start', index: 0 })
  return { ...state, stepStarted: true }
}

const textDelta = (
  state: LifecycleState,
  events: StreamEvent[],
  id: ContentBlockID,
  text: string,
): Result => {
  const withStep = ensureStepStart(state, events)
  if (!withStep.text.has(id)) {
    events.push({ type: 'text-start', id })
    withStep.text.add(id)
  }
  events.push({ type: 'text-delta', id, text })
  return { state: withStep, events }
}

const reasoningDelta = (
  state: LifecycleState,
  events: StreamEvent[],
  id: ContentBlockID,
  text: string,
): Result => {
  const withStep = ensureStepStart(state, events)
  if (!withStep.reasoning.has(id)) {
    events.push({ type: 'reasoning-start', id })
    withStep.reasoning.add(id)
  }
  events.push({ type: 'reasoning-delta', id, text })
  return { state: withStep, events }
}

const closeOpenBlocks = (state: LifecycleState, events: StreamEvent[]): void => {
  for (const id of state.reasoning) events.push({ type: 'reasoning-end', id })
  for (const id of state.text) events.push({ type: 'text-end', id })
  state.reasoning.clear()
  state.text.clear()
}

type FinishInput = { reason: FinishReason; usage?: Usage }

/** Close any open blocks, then emit a step-finish and finish event; reset stepStarted. */
const finish = (state: LifecycleState, events: StreamEvent[], input: FinishInput): Result => {
  const withStep = ensureStepStart(state, events)
  closeOpenBlocks(withStep, events)
  events.push({ type: 'step-finish', index: 0, reason: input.reason, usage: input.usage })
  events.push({ type: 'finish', reason: input.reason, usage: input.usage })
  return { state: { ...withStep, stepStarted: false }, events }
}

export type { FinishInput, LifecycleState, Result }
export { closeOpenBlocks, finish, initial, reasoningDelta, textDelta }
