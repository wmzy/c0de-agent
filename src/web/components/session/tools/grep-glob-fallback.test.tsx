import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FallbackToolView } from '@/components/session/tools/FallbackToolView.js'
import { GlobToolView } from '@/components/session/tools/GlobToolView.js'
import { GrepToolView } from '@/components/session/tools/GrepToolView.js'

describe('GrepToolView', () => {
  afterEach(cleanup)

  it('渲染输出', () => {
    render(
      <GrepToolView
        input={{ pattern: 'foo' }}
        output={{ _tag: 'success', output: 'a.ts:1:foo' }}
        status="completed"
      />,
    )
    expect(screen.getByTestId('tool-output')).toHaveTextContent('a.ts:1:foo')
  })

  // 命中数撞上 maxResults 时 executor 只把 truncated 放进 metadata（output 文本里
  // 没有任何标记，见 src/tools/builtin/grep.ts）。视图此前只读 output 文本，于是
  // 满 200 条和「全部命中」渲染得一模一样：用户据此告诉同事「全仓库就这 200 处」。
  it('命中数被截断时必须说明，而不是把上限当全部', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `f.ts:${i + 1}: foo`).join('\n')
    render(
      <GrepToolView
        input={{ pattern: 'foo' }}
        output={{ _tag: 'success', output: lines, metadata: { count: 200, truncated: true } }}
        status="completed"
      />,
    )
    const note = screen.getByTestId('tool-match-truncated')
    expect(note).toHaveTextContent('已截断')
    expect(note).toHaveTextContent('200')
  })

  it('一个都没匹配到时说明「没有匹配」，而不是渲染成空白', () => {
    render(
      <GrepToolView
        input={{ pattern: 'nope' }}
        output={{ _tag: 'success', output: '', metadata: { count: 0, truncated: false } }}
        status="completed"
      />,
    )
    expect(screen.getByTestId('tool-match-empty')).toHaveTextContent('没有匹配')
    expect(screen.queryByTestId('tool-output')).toBeNull()
  })

  it('未截断且有命中时不加旁白', () => {
    render(
      <GrepToolView
        input={{ pattern: 'foo' }}
        output={{ _tag: 'success', output: 'a.ts:1:foo', metadata: { count: 1, truncated: false } }}
        status="completed"
      />,
    )
    expect(screen.queryByTestId('tool-match-truncated')).toBeNull()
    expect(screen.queryByTestId('tool-match-empty')).toBeNull()
  })

  // 回归（matchSummary）：count 缺失/非数字（metadata 是原样落库的未受信 JSON）时，
  // 旁白此前拼出「已截断：仅显示前  条匹配」的双空格残句。count 无效时不拼数目段。
  it('截断但 count 缺失时不渲染双空格残句', () => {
    render(
      <GrepToolView
        input={{ pattern: 'foo' }}
        output={{ _tag: 'success', output: 'a.ts:1:foo', metadata: { truncated: true } }}
        status="completed"
      />,
    )
    const note = screen.getByTestId('tool-match-truncated')
    expect(note).toHaveTextContent('已截断')
    expect(note.textContent).not.toContain('仅显示前')
    expect(note.textContent).not.toMatch(/ {2}/)
  })
})

describe('GlobToolView', () => {
  afterEach(cleanup)

  it('渲染文件列表', () => {
    render(
      <GlobToolView
        input={{ pattern: '*.ts' }}
        output={{ _tag: 'success', output: 'a.ts\nb.ts' }}
        status="completed"
      />,
    )
    expect(screen.getByTestId('tool-output')).toHaveTextContent('a.ts')
  })

  it('0 个文件匹配时说明「没有匹配」，而不是渲染成空白', () => {
    render(
      <GlobToolView
        input={{ pattern: '*.rs' }}
        output={{ _tag: 'success', output: '', metadata: { count: 0 } }}
        status="completed"
      />,
    )
    expect(screen.getByTestId('tool-match-empty')).toHaveTextContent('没有匹配')
    expect(screen.queryByTestId('tool-output')).toBeNull()
  })

  // 同 grep：count 非数字（脏 metadata）时不拼「前 N 条」段，不说数目也不留空占位。
  it('截断但 count 非数字时不渲染双空格残句', () => {
    render(
      <GlobToolView
        input={{ pattern: '*.ts' }}
        output={{
          _tag: 'success',
          output: 'a.ts\nb.ts',
          metadata: { truncated: true, count: '200' },
        }}
        status="completed"
      />,
    )
    const note = screen.getByTestId('tool-match-truncated')
    expect(note).toHaveTextContent('已截断')
    expect(note.textContent).not.toContain('仅显示前')
    expect(note.textContent).not.toMatch(/ {2}/)
  })
})

describe('FallbackToolView', () => {
  afterEach(cleanup)

  it('拍平展示参数', () => {
    render(<FallbackToolView input={{ a: { b: { c: 1 } }, d: 2 }} tool="custom" />)
    expect(screen.getByTestId('fallback-args').textContent).toContain('a.b.c')
    expect(screen.getByTestId('fallback-args').textContent).toContain('1')
  })

  it('跳过 _parseError/_raw 容错标记（防御旧数据/边角）', () => {
    // 这些标记是后端专用的解析失败容错，绝不应作为参数渲染。
    render(<FallbackToolView input={{ _parseError: 'x', _raw: '{', real: 1 }} tool="custom" />)
    const args = screen.getByTestId('fallback-args')
    expect(args.textContent).toContain('real')
    expect(args.textContent).not.toContain('_parseError')
    expect(args.textContent).not.toContain('_raw')
  })

  it('空入参不渲染参数区', () => {
    render(<FallbackToolView input={{}} tool="custom" />)
    expect(screen.queryByTestId('fallback-args')).toBeNull()
  })
})
