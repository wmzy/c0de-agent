import { describe, expect, it } from 'vitest'
import type { TodoPhase } from '../tools/builtin/todo.js'
import { applyTodoTags, parseTodoTags, resolveSeq } from './todo-tags.js'

// ── Test fixtures ──

const PHASES: TodoPhase[] = [
  {
    name: 'Setup',
    tasks: [
      { content: 'Install deps', status: 'completed' },
      { content: 'Configure DB', status: 'in_progress' },
      { content: 'Write tests', status: 'pending' },
    ],
  },
  {
    name: 'Impl',
    tasks: [{ content: 'Build API', status: 'pending' }],
  },
]

// ── parseTodoTags ──

describe('parseTodoTags', () => {
  it('parses self-closing tags', () => {
    const tags = parseTodoTags('Hello\n<todo:start seq="1-3" />\nWorld')
    expect(tags).toHaveLength(1)
    expect(tags[0]).toEqual({ op: 'start', seq: '1-3' })
  })

  it('parses view tag', () => {
    const tags = parseTodoTags('<todo:view />')
    expect(tags).toHaveLength(1)
    expect(tags[0]).toEqual({ op: 'view' })
  })

  it('parses init with nested phases', () => {
    const text = `<todo:init>
<todo:phase name="Setup">
<todo:item>Task A</todo:item>
<todo:item>Task B</todo:item>
</todo:phase>
<todo:phase name="Impl">
<todo:item>Task C</todo:item>
</todo:phase>
</todo:init>`
    const tags = parseTodoTags(text)
    expect(tags).toHaveLength(1)
    expect(tags[0]).toEqual({
      op: 'init',
      phases: [
        { name: 'Setup', items: ['Task A', 'Task B'] },
        { name: 'Impl', items: ['Task C'] },
      ],
    })
  })

  it('parses append with items', () => {
    const text = `<todo:append phase="2">
<todo:item>New task</todo:item>
</todo:append>`
    const tags = parseTodoTags(text)
    expect(tags).toHaveLength(1)
    expect(tags[0]).toEqual({ op: 'append', phaseSeq: 2, items: ['New task'] })
  })

  it('parses multiple tags in order', () => {
    const text = `<todo:start seq="1-2" />\nText\n<todo:done seq="1-3" />`
    const tags = parseTodoTags(text)
    expect(tags).toHaveLength(2)
    expect(tags[0]).toEqual({ op: 'start', seq: '1-2' })
    expect(tags[1]).toEqual({ op: 'done', seq: '1-3' })
  })

  it('returns empty for text without tags', () => {
    expect(parseTodoTags('Just regular text')).toEqual([])
  })

  it('ignores malformed tags', () => {
    expect(parseTodoTags('<todo:start >')).toEqual([])
    expect(parseTodoTags('<todo:done seq="1-1"')).toEqual([])
  })
})

// ── resolveSeq ──

describe('resolveSeq', () => {
  it('resolves task-level seq', () => {
    const result = resolveSeq(PHASES, '1-2')
    expect(result?.task?.content).toBe('Configure DB')
    expect(result?.phase?.name).toBe('Setup')
  })

  it('resolves phase-level seq', () => {
    const result = resolveSeq(PHASES, '2')
    expect(result?.task).toBeUndefined()
    expect(result?.phase?.name).toBe('Impl')
  })

  it('returns undefined for out-of-bounds phase', () => {
    expect(resolveSeq(PHASES, '9-1')).toBeUndefined()
  })

  it('returns undefined for out-of-bounds task', () => {
    expect(resolveSeq(PHASES, '1-9')).toBeUndefined()
  })

  it('returns undefined for missing seq', () => {
    expect(resolveSeq(PHASES, undefined)).toBeUndefined()
  })

  // 回归：parseInt 接受尾随垃圾/小数/十六进制（'1.5'→1、'1-1x'→1-1、'0x2'→16），
  // 畸形 seq 静默命中真实任务/阶段——<todo:done seq="1.5"> 会悄悄完成整个阶段。
  it('returns undefined for garbage seqs (trailing chars, floats, hex)', () => {
    expect(resolveSeq(PHASES, '1.5')).toBeUndefined()
    expect(resolveSeq(PHASES, '1-1x')).toBeUndefined()
    expect(resolveSeq(PHASES, '1-2-3')).toBeUndefined()
    expect(resolveSeq(PHASES, '0x2')).toBeUndefined()
    expect(resolveSeq(PHASES, ' 2 x')).toBeUndefined()
    expect(resolveSeq(PHASES, '1e2')).toBeUndefined()
  })
})

// ── applyTodoTags ──

describe('applyTodoTags', () => {
  it('applies start tag', () => {
    const { phases, errors } = applyTodoTags(PHASES, '<todo:start seq="1-3" />')
    expect(errors).toHaveLength(0)
    const task = phases[0]?.tasks[2]
    expect(task?.status).toBe('in_progress')
  })

  it('applies done tag', () => {
    const { phases, errors } = applyTodoTags(PHASES, '<todo:done seq="1-2" />')
    expect(errors).toHaveLength(0)
    expect(phases[0]?.tasks[1]?.status).toBe('completed')
  })

  it('applies init tag', () => {
    const text = `<todo:init><todo:phase name="New"><todo:item>Task X</todo:item></todo:phase></todo:init>`
    const { phases, errors } = applyTodoTags(PHASES, text)
    expect(errors).toHaveLength(0)
    expect(phases).toHaveLength(1)
    expect(phases[0]?.name).toBe('New')
  })

  it('applies append tag', () => {
    const text = `<todo:append phase="1"><todo:item>Extra task</todo:item></todo:append>`
    const { phases, errors } = applyTodoTags(PHASES, text)
    expect(errors).toHaveLength(0)
    expect(phases[0]?.tasks).toHaveLength(4)
    expect(phases[0]?.tasks[3]?.content).toBe('Extra task')
  })

  it('applies multiple tags sequentially', () => {
    const text = '<todo:done seq="1-2" />\n<todo:done seq="1-3" />'
    const { phases, errors } = applyTodoTags(PHASES, text)
    expect(errors).toHaveLength(0)
    expect(phases[0]?.tasks[1]?.status).toBe('completed')
    expect(phases[0]?.tasks[2]?.status).toBe('completed')
  })

  it('resolves all seqs against original snapshot', () => {
    // rm shifts indices; both tags resolved against original layout
    const text = '<todo:rm seq="1-1" />\n<todo:done seq="1-3" />'
    const { phases, errors } = applyTodoTags(PHASES, text)
    expect(errors).toHaveLength(0)
    // 'Write tests' was 1-3, now completed
    const writeTests = phases[0]?.tasks.find((t) => t.content === 'Write tests')
    expect(writeTests?.status).toBe('completed')
  })

  it('reports errors for invalid seq', () => {
    const { errors } = applyTodoTags(PHASES, '<todo:done seq="9-9" />')
    expect(errors.length).toBeGreaterThan(0)
  })

  // 回归：'1.5' 被 parseInt 折成 1——phase 级 done 静默完成整个第一阶段。
  it('does not complete a phase for garbage phase-level seq', () => {
    const { phases, errors } = applyTodoTags(PHASES, '<todo:done seq="1.5" />')
    expect(errors.length).toBeGreaterThan(0)
    // 阶段未被静默完成：in_progress/pending 状态原样保留
    expect(phases[0]?.tasks[1]?.status).toBe('in_progress')
    expect(phases[0]?.tasks[2]?.status).toBe('pending')
  })

  // 回归：append 的 phase="1x" 被 parseInt 折成 1——垃圾阶段号静默追加任务。
  it('does not append to a phase for garbage phase attribute', () => {
    const text = `<todo:append phase="1x"><todo:item>Extra task</todo:item></todo:append>`
    const { phases, errors } = applyTodoTags(PHASES, text)
    expect(errors.length).toBeGreaterThan(0)
    expect(phases[0]?.tasks).toHaveLength(3)
  })

  it('detects view tag', () => {
    const { hasView } = applyTodoTags(PHASES, '<todo:view />')
    expect(hasView).toBe(true)
  })

  it('returns no-op for empty text', () => {
    const { phases, errors, hasView } = applyTodoTags(PHASES, 'no tags here')
    expect(errors).toHaveLength(0)
    expect(hasView).toBe(false)
    expect(phases).toEqual(PHASES)
  })

  // 回归：解析不做代码剥离——围栏代码块/行内代码里的 <todo:*> 标签被当作
  // 控制指令真实应用。助手解释标签语法（围栏/反引号示例）会幽灵改写 todo 状态
  //（done 掉任务、把 pending 自动升为 in_progress）。
  it('ignores tags inside fenced code blocks', () => {
    const text = 'The syntax is:\n```\n<todo:done seq="1-2" />\n```\n'
    const { phases, errors } = applyTodoTags(PHASES, text)
    expect(errors).toHaveLength(0)
    expect(phases).toEqual(PHASES)
  })

  it('ignores tags inside inline code', () => {
    const text = 'Use `<todo:done seq="1-2" />` like this'
    const { phases, errors } = applyTodoTags(PHASES, text)
    expect(errors).toHaveLength(0)
    expect(phases).toEqual(PHASES)
  })
})
