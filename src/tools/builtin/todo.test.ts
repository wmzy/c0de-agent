import { describe, expect, it } from 'vitest'
import type { ToolContext } from '../../shared/types/tool.js'
import type { TodoPhase } from './todo.js'
import {
  clonePhases,
  getLatestTodoPhasesFromMessages,
  markdownToPhases,
  nextActionableTask,
  phasesToMarkdown,
  todoMatchesAnyDescription,
  todoTool,
} from './todo.js'

// ── Helpers ───────────────────────────────────────────────

type Phase = { name: string; tasks: { content: string; status: string }[] }

/** Safe indexed access for tests. */
function at<T>(arr: T[], idx: number): T {
  const v = arr[idx]
  if (!v) throw new Error(`Index ${idx} out of bounds (len ${arr.length})`)
  return v
}

function makeCtx(phases: Phase[] = []): ToolContext {
  let state = phases
  return {
    cwd: '/tmp',
    session: { id: 's1', cwd: '/tmp' },
    abort: new AbortController().signal,
    todoState: {
      get: () => state,
      set: (p) => {
        state = p
      },
    },
  }
}

function initPhases(ctx: ToolContext, list: { phase: string; items: string[] }[]) {
  return todoTool.execute({ op: 'init', list }, ctx)
}

async function getState(ctx: ToolContext): Promise<Phase[]> {
  const result = await todoTool.execute({ op: 'view' }, ctx)
  if (result._tag === 'success' && result.metadata) {
    return result.metadata.phases as Phase[]
  }
  return []
}

// ── Types ─────────────────────────────────────────────────

describe('todoTool', () => {
  // ── init ──────────────────────────────────────────────

  it('init creates phases from list', async () => {
    const ctx = makeCtx()
    const result = await initPhases(ctx, [
      { phase: 'Foundation', items: ['Scaffold crate', 'Wire workspace'] },
      { phase: 'Auth', items: ['Port credential store'] },
    ])
    expect(result._tag).toBe('success')
    const phases = await getState(ctx)
    expect(phases).toHaveLength(2)
    expect(at(phases, 0).name).toBe('Foundation')
    expect(at(phases, 0).tasks).toHaveLength(2)
    expect(at(phases, 0).tasks[0]!.status).toBe('in_progress') // auto-promote
    expect(at(phases, 1).tasks[0]!.status).toBe('pending')
  })

  it('init with flat items uses default phase', async () => {
    const ctx = makeCtx()
    const result = await todoTool.execute(
      { op: 'init', items: ['Task A', 'Task B'] },
      ctx,
    )
    expect(result._tag).toBe('success')
    const phases = await getState(ctx)
    expect(phases).toHaveLength(1)
    expect(at(phases, 0).name).toBe('Tasks')
    expect(at(phases, 0).tasks).toHaveLength(2)
  })

  it('init rejects duplicate phase names', async () => {
    const ctx = makeCtx()
    const result = await todoTool.execute(
      {
        op: 'init',
        list: [
          { phase: 'Auth', items: ['Task A'] },
          { phase: 'Auth', items: ['Task B'] },
        ],
      },
      ctx,
    )
    expect(result._tag).toBe('success') // errors in output, not _tag
    if (result._tag === 'success') {
      expect(result.output).toContain('Duplicate phase')
    }
    // State unchanged (empty)
    const phases = await getState(ctx)
    expect(phases).toHaveLength(0)
  })

  it('init replaces existing list', async () => {
    const ctx = makeCtx()
    await initPhases(ctx, [{ phase: 'Old', items: ['Old task'] }])
    await initPhases(ctx, [{ phase: 'New', items: ['New task'] }])
    const phases = await getState(ctx)
    expect(phases).toHaveLength(1)
    expect(at(phases, 0).name).toBe('New')
  })

  // ── start ─────────────────────────────────────────────

  it('start marks a task in_progress and demotes previous', async () => {
    const ctx = makeCtx()
    await initPhases(ctx, [
      { phase: 'P1', items: ['A', 'B'] },
      { phase: 'P2', items: ['C'] },
    ])
    // First pending auto-promoted to 'A'
    await todoTool.execute({ op: 'start', task: 'C' }, ctx)
    const phases = await getState(ctx)
    const taskA = at(phases, 0).tasks[0]!
    const taskC = at(phases, 1).tasks[0]!
    expect(taskA.status).toBe('pending') // demoted
    expect(taskC.status).toBe('in_progress')
  })

  it('start on non-existent task returns error in output', async () => {
    const ctx = makeCtx()
    await initPhases(ctx, [{ phase: 'P1', items: ['A'] }])
    const result = await todoTool.execute({ op: 'start', task: 'Nonexistent' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('not found')
    }
  })

  // ── done ──────────────────────────────────────────────

  it('done marks a single task completed', async () => {
    const ctx = makeCtx()
    await initPhases(ctx, [{ phase: 'P1', items: ['A', 'B'] }])
    await todoTool.execute({ op: 'done', task: 'A' }, ctx)
    const phases = await getState(ctx)
    expect(at(phases, 0).tasks[0]!.status).toBe('completed')
    // Auto-promote: B should now be in_progress
    expect(at(phases, 0).tasks[1]!.status).toBe('in_progress')
  })

  it('done with phase marks all tasks in phase completed', async () => {
    const ctx = makeCtx()
    await initPhases(ctx, [
      { phase: 'P1', items: ['A', 'B'] },
      { phase: 'P2', items: ['C'] },
    ])
    await todoTool.execute({ op: 'done', phase: 'P1' }, ctx)
    const phases = await getState(ctx)
    expect(at(phases, 0).tasks.every((t) => t.status === 'completed')).toBe(true)
    expect(at(phases, 1).tasks[0]!.status).toBe('in_progress') // auto-promote
  })

  // ── drop ──────────────────────────────────────────────

  it('drop marks a task abandoned', async () => {
    const ctx = makeCtx()
    await initPhases(ctx, [{ phase: 'P1', items: ['A', 'B'] }])
    await todoTool.execute({ op: 'drop', task: 'A' }, ctx)
    const phases = await getState(ctx)
    expect(at(phases, 0).tasks[0]!.status).toBe('abandoned')
    expect(at(phases, 0).tasks[1]!.status).toBe('in_progress')
  })

  // ── rm ────────────────────────────────────────────────

  it('rm removes a single task', async () => {
    const ctx = makeCtx()
    await initPhases(ctx, [{ phase: 'P1', items: ['A', 'B', 'C'] }])
    await todoTool.execute({ op: 'rm', task: 'B' }, ctx)
    const phases = await getState(ctx)
    expect(at(phases, 0).tasks).toHaveLength(2)
    expect(at(phases, 0).tasks.find((t) => t.content === 'B')).toBeUndefined()
  })

  it('rm with phase clears that phase', async () => {
    const ctx = makeCtx()
    await initPhases(ctx, [
      { phase: 'P1', items: ['A'] },
      { phase: 'P2', items: ['B'] },
    ])
    await todoTool.execute({ op: 'rm', phase: 'P1' }, ctx)
    const phases = await getState(ctx)
    expect(at(phases, 0).tasks).toHaveLength(0)
    expect(at(phases, 1).tasks).toHaveLength(1)
  })

  it('rm with no args clears all', async () => {
    const ctx = makeCtx()
    await initPhases(ctx, [
      { phase: 'P1', items: ['A'] },
      { phase: 'P2', items: ['B'] },
    ])
    await todoTool.execute({ op: 'rm' }, ctx)
    const phases = await getState(ctx)
    expect(phases.every((p) => p.tasks.length === 0)).toBe(true)
  })

  // ── append ────────────────────────────────────────────

  it('append adds tasks to existing phase', async () => {
    const ctx = makeCtx()
    await initPhases(ctx, [{ phase: 'P1', items: ['A'] }])
    await todoTool.execute({ op: 'append', phase: 'P1', items: ['B', 'C'] }, ctx)
    const phases = await getState(ctx)
    expect(at(phases, 0).tasks).toHaveLength(3)
    expect(at(phases, 0).tasks[2]!.content).toBe('C')
  })

  it('append lazily creates a new phase', async () => {
    const ctx = makeCtx()
    await initPhases(ctx, [{ phase: 'P1', items: ['A'] }])
    await todoTool.execute({ op: 'append', phase: 'P2', items: ['B'] }, ctx)
    const phases = await getState(ctx)
    expect(phases).toHaveLength(2)
    expect(at(phases, 1).name).toBe('P2')
  })

  it('append rejects duplicate task content', async () => {
    const ctx = makeCtx()
    await initPhases(ctx, [{ phase: 'P1', items: ['A'] }])
    const result = await todoTool.execute({ op: 'append', phase: 'P1', items: ['A'] }, ctx)
    if (result._tag === 'success') {
      expect(result.output).toContain('already exists')
    }
    // State unchanged
    const phases = await getState(ctx)
    expect(at(phases, 0).tasks).toHaveLength(1)
  })

  // ── view ──────────────────────────────────────────────

  it('view returns current state without modifying', async () => {
    const ctx = makeCtx()
    await initPhases(ctx, [{ phase: 'P1', items: ['A', 'B'] }])
    // Mark B done (auto-promote would advance)
    await todoTool.execute({ op: 'done', task: 'A' }, ctx)
    const beforePhases = await getState(ctx)

    const result = await todoTool.execute({ op: 'view' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('P1')
      expect(result.output).toContain('A')
    }

    // State unchanged after view
    const afterPhases = await getState(ctx)
    expect(afterPhases).toEqual(beforePhases)
  })

  it('view on empty list returns empty message', async () => {
    const ctx = makeCtx()
    const result = await todoTool.execute({ op: 'view' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('empty')
    }
  })

  // ── metadata ─────────────────────────────────────────

  it('result metadata contains phases', async () => {
    const ctx = makeCtx()
    await initPhases(ctx, [{ phase: 'P1', items: ['A'] }])
    const result = await todoTool.execute({ op: 'view' }, ctx)
    if (result._tag === 'success' && result.metadata) {
      const phases = result.metadata.phases as TodoPhase[]
      expect(phases).toHaveLength(1)
      expect(at(phases, 0).name).toBe('P1')
    }
  })

  it('result metadata contains completedTasks on done', async () => {
    const ctx = makeCtx()
    await initPhases(ctx, [{ phase: 'P1', items: ['A', 'B'] }])
    const result = await todoTool.execute({ op: 'done', task: 'A' }, ctx)
    if (result._tag === 'success' && result.metadata) {
      const completed = result.metadata.completedTasks as { phase: string; content: string }[]
      expect(completed).toHaveLength(1)
      expect(at(completed, 0).content).toBe('A')
    }
  })

  // ── error handling ───────────────────────────────────

  it('task-1 pattern gives helpful error about content-based referencing', async () => {
    const ctx = makeCtx()
    await initPhases(ctx, [{ phase: 'P1', items: ['A'] }])
    const result = await todoTool.execute({ op: 'done', task: 'task-1' }, ctx)
    if (result._tag === 'success') {
      expect(result.output).toContain('referenced by content')
    }
  })
})

// ── Fuzzy match ───────────────────────────────────────────

describe('todoMatchesAnyDescription', () => {
  it('matches exact normalized content', () => {
    expect(todoMatchesAnyDescription('Review Code', ['review code'])).toBe(true)
  })

  it('matches with punctuation differences', () => {
    expect(todoMatchesAnyDescription('Review: Code!', ['review code'])).toBe(true)
  })

  it('matches substring in either direction (>=6 chars)', () => {
    expect(todoMatchesAnyDescription('Sonnet #2: bug scan', ['Sonnet #2'])).toBe(true)
    expect(todoMatchesAnyDescription('Sonnet #2', ['Sonnet #2: bug scan'])).toBe(true)
  })

  it('does not match short substrings (<6 chars)', () => {
    expect(todoMatchesAnyDescription('fix', ['fixing bugs'])).toBe(false)
    expect(todoMatchesAnyDescription('test', ['testing'])).toBe(false)
  })

  it('returns false for empty content', () => {
    expect(todoMatchesAnyDescription('', ['something'])).toBe(false)
  })

  it('returns false for no descriptions', () => {
    expect(todoMatchesAnyDescription('something', [])).toBe(false)
  })
})

// ── Markdown round-trip ───────────────────────────────────

describe('phasesToMarkdown / markdownToPhases', () => {
  it('round-trips a multi-phase list', () => {
    const phases: TodoPhase[] = [
      { name: 'Foundation', tasks: [{ content: 'Scaffold', status: 'completed' }, { content: 'Wire', status: 'in_progress' }] },
      { name: 'Auth', tasks: [{ content: 'OAuth', status: 'pending' }] },
    ]
    const md = phasesToMarkdown(phases)
    const { phases: parsed, errors } = markdownToPhases(md)
    expect(errors).toHaveLength(0)
    expect(parsed).toEqual(phases)
  })

  it('renders correct status markers', () => {
    const phases: TodoPhase[] = [
      {
        name: 'P1',
        tasks: [
          { content: 'pending', status: 'pending' },
          { content: 'active', status: 'in_progress' },
          { content: 'done', status: 'completed' },
          { content: 'dropped', status: 'abandoned' },
        ],
      },
    ]
    const md = phasesToMarkdown(phases)
    expect(md).toContain('- [ ] pending')
    expect(md).toContain('- [/] active')
    expect(md).toContain('- [x] done')
    expect(md).toContain('- [-] dropped')
  })

  it('accepts > and ~ as alternate markers', () => {
    const md = '# P1\n- [>] active\n- [~] dropped\n'
    const { phases, errors } = markdownToPhases(md)
    expect(errors).toHaveLength(0)
    expect(at(phases, 0).tasks[0]!.status).toBe('in_progress')
    expect(at(phases, 0).tasks[1]!.status).toBe('abandoned')
  })

  it('reports error for unknown marker', () => {
    const md = '# P1\n- [?] unknown\n'
    const { errors } = markdownToPhases(md)
    expect(errors.length).toBeGreaterThan(0)
    expect(at(errors, 0)).toContain('unknown status marker')
  })

  it('reports error for unrecognized syntax', () => {
    const md = '# P1\nsome random text\n'
    const { errors } = markdownToPhases(md)
    expect(errors.length).toBeGreaterThan(0)
    expect(at(errors, 0)).toContain('unrecognized syntax')
  })

  it('empty phases produce minimal markdown', () => {
    expect(phasesToMarkdown([])).toBe('# Todos\n')
  })
})

// ── nextActionableTask ────────────────────────────────────

describe('nextActionableTask', () => {
  it('prefers in_progress over first pending', () => {
    const phases: TodoPhase[] = [
      { name: 'P1', tasks: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }] },
      { name: 'P2', tasks: [{ content: 'C', status: 'in_progress' }] },
    ]
    expect(nextActionableTask(phases)?.content).toBe('C')
  })

  it('falls back to first pending', () => {
    const phases: TodoPhase[] = [
      { name: 'P1', tasks: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }] },
    ]
    expect(nextActionableTask(phases)?.content).toBe('B')
  })

  it('returns undefined when all done', () => {
    const phases: TodoPhase[] = [
      { name: 'P1', tasks: [{ content: 'A', status: 'completed' }] },
    ]
    expect(nextActionableTask(phases)).toBeUndefined()
  })
})

// ── getLatestTodoPhasesFromMessages ───────────────────────

describe('getLatestTodoPhasesFromMessages', () => {
  it('extracts phases from latest todo tool result', () => {
    const messages = [
      {
        role: 'tool',
        content: [
          {
            _tag: 'tool_result',
            tool: 'todo',
            output: {
              _tag: 'success',
              metadata: {
                phases: [{ name: 'P1', tasks: [{ content: 'A', status: 'pending' }] }],
              },
            },
          },
        ],
      },
    ]
    const phases = getLatestTodoPhasesFromMessages(messages)
    expect(phases).toHaveLength(1)
    expect(at(phases, 0).name).toBe('P1')
  })

  it('returns most recent when multiple todo results exist', () => {
    const messages = [
      {
        role: 'tool',
        content: [
          {
            _tag: 'tool_result',
            tool: 'todo',
            output: {
              _tag: 'success',
              metadata: { phases: [{ name: 'Old', tasks: [] }] },
            },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            _tag: 'tool_result',
            tool: 'todo',
            output: {
              _tag: 'success',
              metadata: { phases: [{ name: 'New', tasks: [] }] },
            },
          },
        ],
      },
    ]
    const phases = getLatestTodoPhasesFromMessages(messages)
    expect(at(phases, 0).name).toBe('New')
  })

  it('returns empty for no todo results', () => {
    const messages = [
      {
        role: 'tool',
        content: [
          {
            _tag: 'tool_result',
            tool: 'read',
            output: { _tag: 'success' },
          },
        ],
      },
    ]
    expect(getLatestTodoPhasesFromMessages(messages)).toHaveLength(0)
  })

  it('clones phases (mutation safe)', () => {
    const messages = [
      {
        role: 'tool',
        content: [
          {
            _tag: 'tool_result',
            tool: 'todo',
            output: {
              _tag: 'success',
              metadata: { phases: [{ name: 'P1', tasks: [{ content: 'A', status: 'pending' }] }] },
            },
          },
        ],
      },
    ]
    const phases = getLatestTodoPhasesFromMessages(messages)
    at(phases, 0).tasks[0]!.status = 'completed'
    // Re-extract: should still be pending (clone)
    const phases2 = getLatestTodoPhasesFromMessages(messages)
    expect(at(phases2, 0).tasks[0]!.status).toBe('pending')
  })
})

// ── clonePhases ───────────────────────────────────────────

describe('clonePhases', () => {
  it('produces a deep copy', () => {
    const phases: TodoPhase[] = [
      { name: 'P1', tasks: [{ content: 'A', status: 'pending' }] },
    ]
    const cloned = clonePhases(phases)
    at(cloned, 0).tasks[0]!.status = 'completed'
    expect(at(phases, 0).tasks[0]!.status).toBe('pending')
  })
})
