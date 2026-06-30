import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolBlock } from './ToolBlock.js'
import type { RenderBlock } from './utils/normalizeParts.js'

afterEach(() => cleanup())

function toolBlock(
  over: Partial<Extract<RenderBlock, { type: 'tool' }>> = {},
): Extract<RenderBlock, { type: 'tool' }> {
  return {
    type: 'tool',
    id: '1',
    tool: 'read',
    input: { path: 'a.ts' },
    status: 'completed',
    ...over,
  }
}

describe('ToolBlock', () => {
  it('渲染状态 icon', () => {
    render(<ToolBlock block={toolBlock({ status: 'completed' })} />)
    expect(screen.getByTestId('tool-status').getAttribute('data-status')).toBe('completed')
  })

  it('completed 默认折叠，body 不渲染', () => {
    render(<ToolBlock block={toolBlock({ status: 'completed' })} />)
    expect(screen.getByTestId('tool-header').getAttribute('data-expanded')).toBe('false')
    expect(screen.queryByTestId('file-name')).toBeNull()
  })

  it('running 默认展开', () => {
    render(<ToolBlock block={toolBlock({ status: 'running' })} />)
    expect(screen.getByTestId('tool-header').getAttribute('data-expanded')).toBe('true')
  })

  it('点击 header 切换展开/收起', () => {
    render(<ToolBlock block={toolBlock({ status: 'completed' })} />)
    expect(screen.getByTestId('tool-header').getAttribute('data-expanded')).toBe('false')
    fireEvent.click(screen.getByTestId('tool-header'))
    expect(screen.getByTestId('tool-header').getAttribute('data-expanded')).toBe('true')
    expect(screen.getByTestId('file-name')).toHaveTextContent('a.ts')
    fireEvent.click(screen.getByTestId('tool-header'))
    expect(screen.queryByTestId('file-name')).toBeNull()
  })

  it('running → completed 自动收起一次', () => {
    const { rerender } = render(<ToolBlock block={toolBlock({ status: 'running' })} />)
    expect(screen.getByTestId('tool-header').getAttribute('data-expanded')).toBe('true')
    rerender(<ToolBlock block={toolBlock({ status: 'completed' })} />)
    expect(screen.getByTestId('tool-header').getAttribute('data-expanded')).toBe('false')
  })

  it('用户展开后状态变化不覆盖手动展开', () => {
    const { rerender } = render(<ToolBlock block={toolBlock({ status: 'running' })} />)
    rerender(<ToolBlock block={toolBlock({ status: 'completed' })} />)
    // 自动收起后用户手动展开
    fireEvent.click(screen.getByTestId('tool-header'))
    expect(screen.getByTestId('tool-header').getAttribute('data-expanded')).toBe('true')
    // 再次变 completed 不应覆盖
    rerender(<ToolBlock block={toolBlock({ status: 'completed' })} />)
    expect(screen.getByTestId('tool-header').getAttribute('data-expanded')).toBe('true')
  })

  it('摘要文本按工具类型生成（read 显示路径）', () => {
    render(<ToolBlock block={toolBlock({ tool: 'read', input: { path: 'src/a.ts' } })} />)
    expect(screen.getByTestId('tool-header')).toHaveTextContent('read · src/a.ts')
  })

  it('摘要文本按工具类型生成（bash 显示命令首行）', () => {
    render(
      <ToolBlock
        block={toolBlock({ tool: 'bash', input: { command: 'pnpm test' }, status: 'running' })}
      />,
    )
    expect(screen.getByTestId('tool-header')).toHaveTextContent('bash · $ pnpm test')
  })

  it('read 工具分发到 ReadToolView（展开后）', () => {
    render(
      <ToolBlock
        block={toolBlock({
          tool: 'read',
          input: { path: 'a.ts' },
          output: { _tag: 'success', output: 'x' },
        })}
      />,
    )
    fireEvent.click(screen.getByTestId('tool-header'))
    expect(screen.getByTestId('file-name')).toHaveTextContent('a.ts')
  })

  it('未知工具用 FallbackToolView（展开后）', () => {
    render(<ToolBlock block={toolBlock({ tool: 'custom', input: { x: 1 } })} />)
    fireEvent.click(screen.getByTestId('tool-header'))
    expect(screen.getByTestId('fallback-args')).toBeInTheDocument()
  })

  it('paused 状态 header 存在且标记 paused', () => {
    render(<ToolBlock block={toolBlock({ status: 'paused' })} />)
    expect(screen.getByTestId('tool-status').getAttribute('data-status')).toBe('paused')
  })
})
