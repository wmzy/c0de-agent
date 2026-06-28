import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolBlock } from './ToolBlock.js'
import type { RenderBlock } from './utils/normalizeParts.js'

afterEach(() => cleanup())

function toolBlock(
  over: Partial<Extract<RenderBlock, { type: 'tool' }>> = {},
): Extract<RenderBlock, { type: 'tool' }> {
  return { type: 'tool', id: '1', tool: 'read', input: { path: 'a.ts' }, status: 'completed', ...over }
}

describe('ToolBlock', () => {
  it('渲染状态 icon', () => {
    render(<ToolBlock block={toolBlock({ status: 'completed' })} />)
    expect(screen.getByTestId('tool-status').getAttribute('data-status')).toBe('completed')
  })

  it('read 工具分发到 ReadToolView', () => {
    render(
      <ToolBlock
        block={toolBlock({
          tool: 'read',
          input: { path: 'a.ts' },
          output: { _tag: 'success', output: 'x' },
        })}
      />,
    )
    expect(screen.getByTestId('file-name')).toHaveTextContent('a.ts')
  })

  it('未知工具用 FallbackToolView', () => {
    render(<ToolBlock block={toolBlock({ tool: 'custom', input: { x: 1 } })} />)
    expect(screen.getByTestId('fallback-args')).toBeInTheDocument()
  })

  it('paused 状态显示权限提示', () => {
    render(<ToolBlock block={toolBlock({ status: 'paused' })} />)
    expect(screen.getByTestId('tool-status').getAttribute('data-status')).toBe('paused')
  })
})