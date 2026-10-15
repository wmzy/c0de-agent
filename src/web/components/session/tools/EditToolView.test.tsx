import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EditToolView } from '@/components/session/tools/EditToolView.js'

afterEach(cleanup)

describe('EditToolView', () => {
  it('渲染 diff', () => {
    render(
      <EditToolView input={{ path: 'a.ts', oldText: 'old', newText: 'new' }} status="completed" />,
    )
    expect(screen.getByTestId('diff')).toBeInTheDocument()
    // haze DiffViewer：行以 data-slot="line" 标识，类型由行内符号（+/-）判定。
    const rows = screen.getByTestId('diff').querySelectorAll('[data-slot="line"]')
    const removed = Array.from(rows).filter((r) =>
      r.querySelector('[data-slot="sign"]')?.textContent?.startsWith('-'),
    )
    const added = Array.from(rows).filter((r) =>
      r.querySelector('[data-slot="sign"]')?.textContent?.startsWith('+'),
    )
    expect(removed.length).toBe(1)
    expect(added.length).toBe(1)
  })

  it('error 状态显示错误', () => {
    render(
      <EditToolView
        input={{ path: 'a.ts', oldText: 'o', newText: 'n' }}
        status="error"
        output={{ _tag: 'error', error: 'not found' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('not found')
  })
})

/**
 * hashline 模式的编辑此前渲染成**空 diff**：视图只读 input.oldText/newText，而
 * hashline 模式（`{path, patch}`，模型在长会话里被引导优先使用，见 core/loop 的
 * 成功率自适应提示）压根没有这两个字段 → oldText='' / newText=''。一次真实落盘的
 * 编辑在时间线上是一块空白：用户看不出改了什么，误以为没改成。
 *
 * 修法：edit 工具把 applyPatch 的行级变更（metadata.hunks：被替换的原始行 + 写入的
 * 新行）随结果回传，视图据此拼出真实 diff。
 */
describe('EditToolView hashline 模式', () => {
  const hunks = [
    { _tag: 'SWAP', start: 2, end: 2, removed: ['const x = 1'], added: ['const x = 2'] },
  ]

  it('有 hunks 时渲染真实 diff（旧行 -、新行 +）', () => {
    render(
      <EditToolView
        input={{ path: 'a.ts', patch: '[a.ts#1234]\nSWAP 2-2\nconst x = 2\n---\n' }}
        status="completed"
        output={{
          _tag: 'success',
          output: 'Edited "a.ts" via hashline patch (1 block(s))',
          metadata: { hunks },
        }}
      />,
    )
    const rows = screen.getByTestId('diff').querySelectorAll('[data-slot="line"]')
    const sign = (r: Element) => r.querySelector('[data-slot="sign"]')?.textContent ?? ''
    const text = (r: Element) =>
      r.querySelector('[data-slot="line-text"]')?.textContent ?? r.textContent
    const removed = Array.from(rows)
      .filter((r) => sign(r).startsWith('-'))
      .map(text)
    const added = Array.from(rows)
      .filter((r) => sign(r).startsWith('+'))
      .map(text)
    // 行内还带行号，只断言内容（去掉行号前缀）
    expect(removed).toHaveLength(1)
    expect(removed[0]).toContain('const x = 1')
    expect(added).toHaveLength(1)
    expect(added[0]).toContain('const x = 2')
    expect(screen.queryByTestId('edit-hashline-output')).toBeNull()
  })

  it('旧消息（结果里没有 hunks）不再渲染空 diff，而是给出工具的结论文本', () => {
    render(
      <EditToolView
        input={{ path: 'a.ts', patch: '[a.ts#1234]\nSWAP 2-2\nx\n---\n' }}
        status="completed"
        output={{ _tag: 'success', output: 'Edited "a.ts" via hashline patch (1 block(s))' }}
      />,
    )
    expect(screen.queryByTestId('diff')).toBeNull()
    expect(screen.getByTestId('edit-hashline-output')).toHaveTextContent(
      'Edited "a.ts" via hashline patch (1 block(s))',
    )
  })

  it('运行中还没有结果时说明正在应用补丁，而不是空白', () => {
    render(
      <EditToolView
        input={{ path: 'a.ts', patch: '[a.ts#1234]\nSWAP 2-2\nx\n---\n' }}
        status="running"
      />,
    )
    expect(screen.getByTestId('edit-hashline-output')).toHaveTextContent('正在应用补丁')
  })

  it('hashline 失败仍给失败原因', () => {
    render(
      <EditToolView
        input={{ path: 'a.ts', patch: '[a.ts#1234]\nSWAP 2-2\nx\n---\n' }}
        status="error"
        output={{ _tag: 'error', error: 'hashline: hash mismatch (expected 1234, actual 9999)' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('hash mismatch')
  })
})
