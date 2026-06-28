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
        output={{ _tag: 'success', output: 'a.ts:1:foo' } as any}
        status="completed"
      />,
    )
    expect(screen.getByTestId('tool-title')).toHaveTextContent('foo')
  })

  it('渲染输出', () => {
    render(
      <GrepToolView
        input={{ pattern: 'foo' }}
        output={{ _tag: 'success', output: 'a.ts:1:foo' } as any}
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
        output={{ _tag: 'success', output: 'a.ts\nb.ts' } as any}
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
})
