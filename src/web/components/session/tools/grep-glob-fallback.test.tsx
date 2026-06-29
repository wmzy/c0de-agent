import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FallbackToolView } from './FallbackToolView.js'
import { GlobToolView } from './GlobToolView.js'
import { GrepToolView } from './GrepToolView.js'

describe('GrepToolView', () => {
  afterEach(cleanup)

  it('渲染 pattern', () => {
    render(
      <GrepToolView
        input={{ pattern: 'foo' }}
        output={{ _tag: 'success', output: 'a.ts:1:foo' }}
        status="completed"
      />,
    )
    expect(screen.getByTestId('tool-title')).toHaveTextContent('foo')
  })

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
})

describe('GlobToolView', () => {
  afterEach(cleanup)

  it('渲染 pattern 与文件列表', () => {
    render(
      <GlobToolView
        input={{ pattern: '*.ts' }}
        output={{ _tag: 'success', output: 'a.ts\nb.ts' }}
        status="completed"
      />,
    )
    expect(screen.getByTestId('tool-title')).toHaveTextContent('*.ts')
    expect(screen.getByTestId('tool-output')).toHaveTextContent('a.ts')
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
