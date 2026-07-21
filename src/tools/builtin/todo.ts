// todo tool: phased task tracking with 7 operations, fuzzy matching, and
// Markdown round-trip. Logic ported from oh-my-pi, adapted to c0de-agent's
// stateless ToolDef + ToolContext.todoState hook pattern.

import type { JSONSchema } from '../../shared/types/base.js'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'

// =============================================================================
// Types
// =============================================================================

type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned'

type TodoItem = {
  content: string
  status: TodoStatus
}

type TodoPhase = {
  name: string
  tasks: TodoItem[]
}

/** A single todo operation entry (the tool's input params). */
type TodoInput =
  | { op: 'init'; list?: { phase: string; items: string[] }[]; phase?: string; items?: string[] }
  | { op: 'start'; task: string }
  | { op: 'done'; task?: string; phase?: string }
  | { op: 'drop'; task?: string; phase?: string }
  | { op: 'rm'; task?: string; phase?: string }
  | { op: 'append'; phase: string; items: string[] }
  | { op: 'view' }

/** Phase + task identifier for a completion transition. */
type TodoCompletionTransition = {
  phase: string
  content: string
}

// =============================================================================
// State helpers
// =============================================================================

function findTaskByContent(
  phases: TodoPhase[],
  content: string,
): { task: TodoItem; phase: TodoPhase } | undefined {
  for (const phase of phases) {
    const task = phase.tasks.find((t) => t.content === content)
    if (task) return { task, phase }
  }
  return undefined
}

function findPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined {
  return phases.find((phase) => phase.name === name)
}

function cloneTask(task: TodoItem): TodoItem {
  return { content: task.content, status: task.status }
}

/** Deep-clone phases (mutation-safe). */
export function clonePhases(phases: TodoPhase[]): TodoPhase[] {
  return phases.map((phase) => ({ name: phase.name, tasks: phase.tasks.map(cloneTask) }))
}

function todoTransitionKey(phase: string, content: string): string {
  return `${phase}\u0000${content}`
}

function getCompletionTransitions(
  previous: TodoPhase[],
  updated: TodoPhase[],
): TodoCompletionTransition[] {
  const previousStatuses = new Map<string, TodoStatus>()
  for (const phase of previous) {
    for (const task of phase.tasks) {
      previousStatuses.set(todoTransitionKey(phase.name, task.content), task.status)
    }
  }

  const transitions: TodoCompletionTransition[] = []
  for (const phase of updated) {
    for (const task of phase.tasks) {
      if (task.status !== 'completed') continue
      const prev = previousStatuses.get(todoTransitionKey(phase.name, task.content))
      if (prev && prev !== 'completed') {
        transitions.push({ phase: phase.name, content: task.content })
      }
    }
  }
  return transitions
}

/** Ensure at most one in_progress task: demote extras, or auto-promote the
 *  first pending task if none is in_progress. Mutates in place. */
function normalizeInProgressTask(phases: TodoPhase[]): void {
  const orderedTasks = phases.flatMap((phase) => phase.tasks)
  if (orderedTasks.length === 0) return

  const inProgressTasks = orderedTasks.filter((task) => task.status === 'in_progress')
  if (inProgressTasks.length > 1) {
    for (const task of inProgressTasks.slice(1)) {
      task.status = 'pending'
    }
  }

  if (inProgressTasks.length > 0) return

  const firstPending = orderedTasks.find((task) => task.status === 'pending')
  if (firstPending) firstPending.status = 'in_progress'
}

/** Return the active todo task, preferring in_progress over the first pending. */
export function nextActionableTask(phases: readonly TodoPhase[]): TodoItem | undefined {
  let firstPending: TodoItem | undefined
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.status === 'in_progress') return task
      if (!firstPending && task.status === 'pending') firstPending = task
    }
  }
  return firstPending
}

// =============================================================================
// Fuzzy match
// =============================================================================

/** Minimum overlap (after normalization) required for a substring match.
 *  Six chars admits single-word identifiers like "review" / "Sonnet" without
 *  admitting tiny common substrings like "test" / "fix". */
const TODO_DESCRIPTION_MIN_OVERLAP = 6

function normalizeForTodoMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Report whether `content` likely names the same work as any entry in
 *  `descriptions`. Normalize-then-equal first, with a substring fallback
 *  in either direction (≥6 char overlap on the contained side). */
export function todoMatchesAnyDescription(content: string, descriptions: readonly string[]): boolean {
  const target = normalizeForTodoMatch(content)
  if (!target) return false
  for (const desc of descriptions) {
    const candidate = normalizeForTodoMatch(desc)
    if (!candidate) continue
    if (target === candidate) return true
    if (target.length >= TODO_DESCRIPTION_MIN_OVERLAP && candidate.includes(target)) return true
    if (candidate.length >= TODO_DESCRIPTION_MIN_OVERLAP && target.includes(candidate)) return true
  }
  return false
}

// =============================================================================
// Resolution helpers
// =============================================================================

function resolveTaskOrError(
  phases: TodoPhase[],
  content: string | undefined,
  errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
  if (!content) {
    errors.push('Missing task content')
    return undefined
  }
  const hit = findTaskByContent(phases, content)
  if (!hit) {
    if (/^task-\d+$/.test(content)) {
      errors.push(
        `Task "${content}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`,
      )
    } else {
      const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0)
      const hint =
        totalTasks === 0 ? ' (todo list is empty — was it replaced or not yet created?)' : ''
      errors.push(`Task "${content}" not found${hint}`)
    }
  }
  return hit
}

function resolvePhaseOrError(
  phases: TodoPhase[],
  name: string | undefined,
  errors: string[],
): TodoPhase | undefined {
  if (!name) {
    errors.push('Missing phase name')
    return undefined
  }
  const phase = findPhaseByName(phases, name)
  if (!phase) errors.push(`Phase "${name}" not found`)
  return phase
}

function getTaskTargets(phases: TodoPhase[], entry: TodoInput, errors: string[]): TodoItem[] {
  if ('task' in entry && entry.task) {
    const hit = resolveTaskOrError(phases, entry.task, errors)
    return hit ? [hit.task] : []
  }
  if ('phase' in entry && entry.phase) {
    const phase = resolvePhaseOrError(phases, entry.phase, errors)
    return phase ? [...phase.tasks] : []
  }
  return phases.flatMap((phase) => phase.tasks)
}

// =============================================================================
// Operations
// =============================================================================

/** Phase name for `init` given a flat `items` list with no explicit `phase`. */
const DEFAULT_INIT_PHASE = 'Tasks'

function initPhases(entry: Extract<TodoInput, { op: 'init' }>, errors: string[]): TodoPhase[] {
  // Models routinely flatten single-phase init into {op:"init", items:[...]}
  // instead of the canonical list: [{phase, items}]. Accept that shape.
  const list =
    entry.list ??
    (entry.items && entry.items.length > 0
      ? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
      : undefined)
  if (!list) {
    errors.push('Missing list for init operation')
    return []
  }

  const seenPhases = new Set<string>()
  const seenTasks = new Set<string>()
  for (const listEntry of list) {
    if (seenPhases.has(listEntry.phase)) {
      errors.push(`Duplicate phase "${listEntry.phase}" in init list`)
    }
    seenPhases.add(listEntry.phase)
    for (const content of listEntry.items) {
      if (seenTasks.has(content)) {
        errors.push(`Duplicate task "${content}" in init list`)
      }
      seenTasks.add(content)
    }
  }

  return list.map((listEntry) => ({
    name: listEntry.phase,
    tasks: listEntry.items.map<TodoItem>((content) => ({ content, status: 'pending' })),
  }))
}

function appendItems(
  phases: TodoPhase[],
  entry: Extract<TodoInput, { op: 'append' }>,
  errors: string[],
): TodoPhase[] {
  if (!entry.items || entry.items.length === 0) {
    errors.push('Missing items for append operation')
    return phases
  }

  // Validate the whole batch before mutating.
  const seen = new Set<string>()
  let hasDuplicate = false
  for (const content of entry.items) {
    if (seen.has(content) || findTaskByContent(phases, content)) {
      errors.push(`Task "${content}" already exists`)
      hasDuplicate = true
    }
    seen.add(content)
  }
  if (hasDuplicate) return phases

  let phase = findPhaseByName(phases, entry.phase)
  if (!phase) {
    phase = { name: entry.phase, tasks: [] }
    phases.push(phase)
  }

  for (const content of entry.items) {
    phase.tasks.push({ content, status: 'pending' })
  }
  return phases
}

function removeTasks(
  phases: TodoPhase[],
  entry: Extract<TodoInput, { op: 'rm' }>,
  errors: string[],
): TodoPhase[] {
  if (entry.task) {
    const hit = resolveTaskOrError(phases, entry.task, errors)
    if (!hit) return phases
    hit.phase.tasks = hit.phase.tasks.filter((candidate) => candidate !== hit.task)
    return phases
  }
  if (entry.phase) {
    const phase = resolvePhaseOrError(phases, entry.phase, errors)
    if (!phase) return phases
    phase.tasks = []
    return phases
  }
  // No task or phase specified: clear all.
  for (const phase of phases) {
    phase.tasks = []
  }
  return phases
}

function applyEntry(phases: TodoPhase[], entry: TodoInput, errors: string[]): TodoPhase[] {
  switch (entry.op) {
    case 'init':
      return initPhases(entry, errors)
    case 'start': {
      const hit = resolveTaskOrError(phases, entry.task, errors)
      if (!hit) return phases
      for (const phase of phases) {
        for (const candidate of phase.tasks) {
          if (candidate.status === 'in_progress' && candidate !== hit.task) {
            candidate.status = 'pending'
          }
        }
      }
      hit.task.status = 'in_progress'
      return phases
    }
    case 'done': {
      for (const task of getTaskTargets(phases, entry, errors)) {
        task.status = 'completed'
      }
      return phases
    }
    case 'drop': {
      for (const task of getTaskTargets(phases, entry, errors)) {
        task.status = 'abandoned'
      }
      return phases
    }
    case 'rm':
      return removeTasks(phases, entry, errors)
    case 'append':
      return appendItems(phases, entry, errors)
    case 'view':
      return phases
  }
}

/** Apply a single todo op to existing phases. Returns new phases + errors. */
function applyParams(
  phases: TodoPhase[],
  params: TodoInput,
): { phases: TodoPhase[]; errors: string[] } {
  const errors: string[] = []
  const next = applyEntry(phases, params, errors)
  normalizeInProgressTask(next)
  return { phases: next, errors }
}

// =============================================================================
// Markdown round-trip
// =============================================================================

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
  pending: ' ',
  in_progress: '/',
  completed: 'x',
  abandoned: '-',
}

/** Render todo phases as a Markdown checklist suitable for editing/copying. */
export function phasesToMarkdown(phases: TodoPhase[]): string {
  if (phases.length === 0) return '# Todos\n'
  const out: string[] = []
  for (let i = 0; i < phases.length; i++) {
    if (i > 0) out.push('')
    const phase = phases[i]!
    out.push(`# ${phase.name}`)
    for (const task of phase.tasks) {
      out.push(`- [${STATUS_TO_MARKER[task.status]}] ${task.content}`)
    }
  }
  return `${out.join('\n')}\n`
}

const MARKER_TO_STATUS: Record<string, TodoStatus> = {
  ' ': 'pending',
  '': 'pending',
  x: 'completed',
  X: 'completed',
  '/': 'in_progress',
  '>': 'in_progress',
  '-': 'abandoned',
  '~': 'abandoned',
}

/** Parse a Markdown checklist back into todo phases. */
export function markdownToPhases(md: string): { phases: TodoPhase[]; errors: string[] } {
  const errors: string[] = []
  const phases: TodoPhase[] = []
  let currentPhase: TodoPhase | undefined

  const lines = md.split(/\r?\n/)
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const raw = lines[lineNum]!
    const trimmed = raw.trim()
    if (!trimmed) continue

    const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed)
    if (headingMatch) {
      currentPhase = { name: headingMatch[1]!.trim(), tasks: [] }
      phases.push(currentPhase)
      continue
    }

    const taskMatch = /^[-*+]\s*\[(.?)\]\s+(.+?)\s*$/.exec(trimmed)
    if (taskMatch) {
      if (!currentPhase) {
        currentPhase = { name: 'Todos', tasks: [] }
        phases.push(currentPhase)
      }
      const marker = taskMatch[1] ?? ''
      const status = MARKER_TO_STATUS[marker]
      if (!status) {
        errors.push(
          `Line ${lineNum + 1}: unknown status marker "[${marker}]" (use [ ], [x], [/], [-])`,
        )
        continue
      }
      currentPhase.tasks.push({ content: taskMatch[2]!.trim(), status })
      continue
    }

    errors.push(`Line ${lineNum + 1}: unrecognized syntax "${trimmed}"`)
  }

  normalizeInProgressTask(phases)
  return { phases, errors }
}

// =============================================================================
// Summary formatter
// =============================================================================

export function formatSummary(phases: TodoPhase[], errors: string[], readOnly = false): string {
  const tasks = phases.flatMap((phase) => phase.tasks)
  if (tasks.length === 0) {
    if (errors.length > 0) return `Errors: ${errors.join('; ')}`
    return readOnly ? 'Todo list is empty.' : 'Todo list cleared.'
  }

  const remainingByPhase = phases
    .map((phase, pi) => ({
      name: phase.name,
      tasks: phase.tasks
        .map((task, ti) => ({ task, seq: `${pi + 1}-${ti + 1}` }))
        .filter(({ task }) => task.status === 'pending' || task.status === 'in_progress'),
    }))
    .filter((phase) => phase.tasks.length > 0)
  const remainingTasks = remainingByPhase.flatMap((phase) =>
    phase.tasks.map(({ task, seq }) => ({ ...task, seq, phase: phase.name })),
  )

  let currentIdx = phases.findIndex((phase) =>
    phase.tasks.some((task) => task.status === 'pending' || task.status === 'in_progress'),
  )
  if (currentIdx === -1) currentIdx = phases.length - 1
  const current = phases[currentIdx]!
  const done = current.tasks.filter(
    (task) => task.status === 'completed' || task.status === 'abandoned',
  ).length

  const lines: string[] = []
  if (errors.length > 0) lines.push(`Errors: ${errors.join('; ')}`)
  if (remainingTasks.length === 0) {
    lines.push('Remaining items: none.')
  } else {
    lines.push(`Remaining items (${remainingTasks.length}):`)
    for (const task of remainingTasks) {
      lines.push(`  - ${task.seq}: ${task.content} [${task.status}] (${task.phase})`)
    }
  }
  const closedAll = tasks.filter(
    (task) => task.status === 'completed' || task.status === 'abandoned',
  ).length
  const workedAhead = phases.some(
    (phase, idx) =>
      idx > currentIdx &&
      phase.tasks.some((task) => task.status === 'completed' || task.status === 'abandoned'),
  )
  lines.push(`Overall: ${closedAll}/${tasks.length} done, ${remainingTasks.length} open.`)
  lines.push(
    `Active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${done}/${current.tasks.length})${
      workedAhead
        ? ' — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed).'
        : '.'
    }`,
  )
  for (let pi = 0; pi < phases.length; pi++) {
    const phase = phases[pi]!
    lines.push(`  ${phase.name}:`)
    for (let ti = 0; ti < phase.tasks.length; ti++) {
      const task = phase.tasks[ti]!
      const seq = `${pi + 1}-${ti + 1}`
      const checkbox = task.status === 'completed' ? '[X]' : '[ ]'
      const tag =
        task.status === 'in_progress'
          ? ' (in progress)'
          : task.status === 'abandoned'
            ? ' (dropped)'
            : ''
      lines.push(`    - ${checkbox} ${seq}: ${task.content}${tag}`)
    }
  }
  return lines.join('\n')
}

// =============================================================================
// Session resume: extract latest phases from messages
// =============================================================================

/** Extract the latest todo phases from stored messages (tool results).
 *  Scans backwards for the most recent `todo` tool result with phases metadata. */
export function getLatestTodoPhasesFromMessages(messages: {
  role: string
  content: unknown[]
}[]): TodoPhase[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role !== 'tool') continue
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const part = msg.content[j] as Record<string, unknown> | undefined
      if (!part || part._tag !== 'tool_result') continue
      if (part.tool !== 'todo') continue
      const output = part.output as Record<string, unknown> | undefined
      if (!output || output._tag !== 'success') continue
      const metadata = output.metadata as { phases?: unknown } | undefined
      if (metadata && Array.isArray(metadata.phases)) {
        return clonePhases(metadata.phases as TodoPhase[])
      }
    }
  }
  return []
}

// =============================================================================
// Schema
// =============================================================================

const todoParameters: JSONSchema = {
  type: 'object',
  description: 'Apply a single todo operation',
  properties: {
    op: {
      type: 'string',
      enum: ['init', 'start', 'done', 'rm', 'drop', 'append', 'view'],
      description: 'Operation to apply',
    },
    list: {
      type: 'array',
      description: 'Phased task list (init only). Each entry has a phase name and task items.',
      items: {
        type: 'object',
        properties: {
          phase: { type: 'string', description: 'Phase name' },
          items: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Task content strings for this phase',
          },
        },
        required: ['phase', 'items'],
      },
    },
    task: { type: 'string', description: 'Task content (for start/done/drop/rm)' },
    phase: { type: 'string', description: 'Phase name (for done/drop/rm/append, or init flat mode)' },
    items: {
      type: 'array',
      items: { type: 'string' },
      description: 'Tasks to append (append), or flat init items (init)',
    },
  },
  required: ['op'],
  additionalProperties: false,
}

// =============================================================================
// Tool definition
// =============================================================================

/** todo tool: phased task tracking with 7 operations.
 *  Permission: auto (no side effects beyond session state).
 *  State is held in-memory via ctx.todoState hook (dependency-reversal). */
export const todoTool: ToolDef = {
  name: 'todo',
  description:
    'Manage a phased task list to track progress within a session. 7 operations: init (create/replace list), start (mark in progress), done (mark completed), drop (mark abandoned), rm (remove task/phase), append (add tasks to a phase), view (read-only). Tasks auto-promote: completing a task moves the in-progress pointer to the next pending task. Pass the task content text (NOT an ID) to target a specific task.',
  parameters: todoParameters,
  permission: 'auto',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const params = input as TodoInput
    const todoState = ctx.todoState
    if (!todoState) {
      return { _tag: 'error', error: 'Todo state not available in this context' }
    }

    const previousPhases = clonePhases(todoState.get() as TodoPhase[])
    const readOnly = params.op === 'view'

    const { phases: updated, errors } = readOnly
      ? { phases: previousPhases, errors: [] as string[] }
      : applyParams(clonePhases(previousPhases), params)

    // A batch with any error is discarded wholesale: persisting a half-applied
    // batch makes the natural retry hit "already exists" for the ops that did land.
    const failed = errors.length > 0
    const effective = failed ? previousPhases : updated
    const completedTasks = readOnly || failed ? [] : getCompletionTransitions(previousPhases, updated)

    if (!readOnly && !failed) {
      todoState.set(updated)
    }

    const output = formatSummary(effective, errors, readOnly)
    const metadata: Record<string, unknown> = { phases: effective }
    if (completedTasks.length > 0) {
      metadata.completedTasks = completedTasks
    }

    // Always return success: errors are surfaced in the output text so the
    // LLM can read them and retry. This avoids skewing tool metrics (a
    // "task not found" is a user error, not a tool failure) and preserves
    // metadata.phases for the LLM to reference on retry.
    return { _tag: 'success', output, metadata }
  },
}

export { applyParams }
export type { TodoInput, TodoItem, TodoPhase, TodoStatus }
