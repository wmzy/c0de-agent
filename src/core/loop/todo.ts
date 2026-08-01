import type { AgentEvent, AgentState } from '../../shared/types/agent.js'
import { formatSummary, type TodoPhase } from '../../tools/builtin/todo.js'
import { injectSteering } from '../steering.js'
import { applyTodoTags } from '../todo-tags.js'

/** Process <todo:*> tags embedded in assistant text.
 *  Parses tags, applies them to state.todoPhases via applyTodoTags,
 *  yields todo_update event on success, injects steering on error/view. */
export async function* processTodoTags(
  state: AgentState,
  text: string,
): AsyncGenerator<AgentEvent> {
  if (text.length === 0) return
  const result = applyTodoTags(state.todoPhases as TodoPhase[], text)

  if (result.errors.length > 0) {
    // Inject error feedback into steering queue for next turn
    injectSteering(state, `<todo-tag-errors>\n${result.errors.join('\n')}\n</todo-tag-errors>`)
  }
  if (result.hasView) {
    // View request: inject current state (with seq) into steering
    const summary = formatSummary(result.phases, [], true)
    injectSteering(state, `<todo-state>\n${summary}\n</todo-state>`)
  }

  // Emit event + update state if anything happened
  const tagsFound = result.errors.length > 0 || result.hasView || result.phases !== state.todoPhases
  if (tagsFound) {
    state.todoPhases = result.phases
    yield { _tag: 'todo_update', phases: result.phases }
  }
}
