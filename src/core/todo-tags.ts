// todo-tags: parse <todo:*> tags from assistant text and apply them to todo phases.
// Acts as a format-conversion layer on top of todo.ts's applyParams state machine.
// Tags are NOT stripped from the text — they remain visible to the user.

import {
  applyParams,
  clonePhases,
  type TodoInput,
  type TodoItem,
  type TodoPhase,
} from '../tools/builtin/todo.js'

// =============================================================================
// Types
// =============================================================================

/** A parsed todo tag, before seq resolution. */
type ParsedTodoTag =
  | { op: 'init'; phases: { name: string; items: string[] }[] }
  | { op: 'start'; seq: string | undefined }
  | { op: 'done'; seq: string | undefined }
  | { op: 'drop'; seq: string | undefined }
  | { op: 'rm'; seq: string | undefined }
  | { op: 'append'; phaseSeq: number; items: string[] }
  | { op: 'view' }

/** Result of applying todo tags to phases. */
type ApplyTodoTagsResult = {
  phases: TodoPhase[]
  errors: string[]
  hasView: boolean
}

// =============================================================================
// Tag parser
// =============================================================================

/** Unified regex matching self-closing and container todo tags.
 *  Group 1 = tag name, Group 2 = attributes, Group 3 = inner content (undefined for self-closing).
 *  Backreference \1 ensures container close tag matches open tag. */
const TAG_RE = /<todo:(\w+)([^>]*?)(?:\/>|>([\s\S]*?)<\/todo:\1>)/g

/** Parse <todo:item> tags from inner content. */
function parseItems(inner: string): string[] {
  const items: string[] = []
  const itemRe = /<todo:item>([\s\S]*?)<\/todo:item>/g
  for (const m of inner.matchAll(itemRe)) {
    items.push((m[1] ?? '').trim())
  }
  return items
}

/** Parse <todo:phase> blocks from init inner content. */
function parseInitInner(inner: string): { name: string; items: string[] }[] {
  const phases: { name: string; items: string[] }[] = []
  const phaseRe = /<todo:phase\s+name="([^"]+)">([\s\S]*?)<\/todo:phase>/g
  for (const m of inner.matchAll(phaseRe)) {
    phases.push({ name: (m[1] ?? '').trim(), items: parseItems(m[2] ?? '') })
  }
  // Flat items without phase wrapper → default phase
  if (phases.length === 0) {
    const flat = parseItems(inner)
    if (flat.length > 0) phases.push({ name: 'Tasks', items: flat })
  }
  return phases
}

/** Parse all todo tags from text, preserving document order. */
export function parseTodoTags(text: string): ParsedTodoTag[] {
  const tags: ParsedTodoTag[] = []
  for (const m of text.matchAll(TAG_RE)) {
    const op = m[1] ?? ''
    const attrs = m[2] ?? ''
    const inner = m[3]

    // Skip structural tags parsed as part of init/append
    if (op === 'phase' || op === 'item') continue

    switch (op) {
      case 'init':
        tags.push({ op: 'init', phases: parseInitInner(inner ?? '') })
        break
      case 'append': {
        const phaseMatch = /phase="([^"]+)"/.exec(attrs)
        const phaseSeq = phaseMatch ? Number.parseInt(phaseMatch[1] ?? '', 10) : Number.NaN
        tags.push({ op: 'append', phaseSeq, items: parseItems(inner ?? '') })
        break
      }
      case 'start':
      case 'done':
      case 'drop':
      case 'rm': {
        const seqMatch = /seq="([^"]+)"/.exec(attrs)
        tags.push({ op, seq: seqMatch?.[1]?.trim() })
        break
      }
      case 'view':
        tags.push({ op: 'view' })
        break
      // Unknown tag names are silently ignored
    }
  }
  return tags
}

// =============================================================================
// Seq resolver
// =============================================================================

/** Resolve a seq string ("1-2" or "1") to a phase and/or task.
 *  Returns undefined if out of bounds or unparseable. */
export function resolveSeq(
  phases: TodoPhase[],
  seq: string | undefined,
): { phase: TodoPhase; task?: TodoItem } | undefined {
  if (!seq) return undefined
  const parts = seq.split('-').map((s) => Number.parseInt(s.trim(), 10))
  const phaseNum = parts[0]
  if (phaseNum === undefined || Number.isNaN(phaseNum)) return undefined

  const phaseIdx = phaseNum - 1
  if (phaseIdx < 0 || phaseIdx >= phases.length) return undefined
  const phase = phases[phaseIdx]
  if (!phase) return undefined

  if (parts.length === 1) return { phase }

  const taskNum = parts[1]
  if (taskNum === undefined || Number.isNaN(taskNum)) return undefined
  const taskIdx = taskNum - 1
  if (taskIdx < 0 || taskIdx >= phase.tasks.length) return undefined
  const task = phase.tasks[taskIdx]
  if (!task) return undefined
  return { phase, task }
}

// =============================================================================
// Tag → TodoInput converter
// =============================================================================

/** Convert a parsed tag to a TodoInput, resolving seq against the given phases snapshot. */
function tagToTodoInput(
  phases: TodoPhase[],
  tag: ParsedTodoTag,
): { input?: TodoInput; error?: string } {
  switch (tag.op) {
    case 'init':
      return {
        input: {
          op: 'init',
          list: tag.phases.map((p) => ({ phase: p.name, items: p.items })),
        },
      }
    case 'append': {
      if (Number.isNaN(tag.phaseSeq) || tag.phaseSeq < 1 || tag.phaseSeq > phases.length) {
        return { error: `Phase ${tag.phaseSeq} not found (have ${phases.length} phases)` }
      }
      const targetPhase = phases[tag.phaseSeq - 1]
      if (!targetPhase) {
        return { error: `Phase ${tag.phaseSeq} not found (have ${phases.length} phases)` }
      }
      return {
        input: {
          op: 'append',
          phase: targetPhase.name,
          items: tag.items,
        },
      }
    }
    case 'view':
      return { input: { op: 'view' } }
    case 'start': {
      const resolved = resolveSeq(phases, tag.seq)
      if (!resolved) return { error: `Invalid seq "${tag.seq}"` }
      if (!resolved.task)
        return { error: 'start requires a task-level seq (e.g. "1-2"), not phase-level' }
      return { input: { op: 'start', task: resolved.task.content } }
    }
    case 'done':
    case 'drop':
    case 'rm': {
      const resolved = resolveSeq(phases, tag.seq)
      if (!resolved) return { error: `Invalid seq "${tag.seq}"` }
      if (!resolved.task) return { input: { op: tag.op, phase: resolved.phase.name } }
      return { input: { op: tag.op, task: resolved.task.content } }
    }
  }
}

// =============================================================================
// Main entry: applyTodoTags
// =============================================================================

/** Parse todo tags from text, resolve all seqs against the original snapshot,
 *  then apply sequentially. Tags are applied in document order.
 *  Does NOT mutate the input phases (clones first). */
export function applyTodoTags(phases: TodoPhase[], text: string): ApplyTodoTagsResult {
  const tags = parseTodoTags(text)
  if (tags.length === 0) return { phases, errors: [], hasView: false }

  // Pre-resolve all seqs against the original snapshot (LLM writes all tags
  // based on one view; rm shifting must not corrupt later references).
  const inputs: TodoInput[] = []
  const errors: string[] = []
  let hasView = false

  for (const tag of tags) {
    if (tag.op === 'view') {
      hasView = true
      continue
    }
    const { input, error } = tagToTodoInput(phases, tag)
    if (error) errors.push(error)
    else if (input) inputs.push(input)
  }

  // Apply sequentially on a clone
  let current = clonePhases(phases)
  for (const input of inputs) {
    const result = applyParams(current, input)
    if (result.errors.length > 0) {
      errors.push(...result.errors)
    } else {
      current = result.phases
    }
  }

  return { phases: current, errors, hasView }
}
