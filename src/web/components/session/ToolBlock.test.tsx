import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolBlock } from '@/components/session/ToolBlock.js'
import type { RenderBlock } from '@/components/session/utils/normalizeParts.js'
import { FileSelectionContext } from '@/contexts/FileSelectionContext.js'

afterEach(() => cleanup())

// header 的 FilePathLink 依赖 FileSelectionContext，需包裹 Provider
function SelectionWrapper({
  children,
  openFile = vi.fn(),
}: {
  children: React.ReactNode
  openFile?: ReturnType<typeof vi.fn>
}) {
  return (
    <FileSelectionContext.Provider
      value={{ selectedFile: null, openFile: openFile as never, closeFile: () => {} }}
    >
      {children}
    </FileSelectionContext.Provider>
  )
}
const render = (ui: React.ReactNode) => rtlRender(ui, { wrapper: SelectionWrapper })

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
    expect(screen.queryByTestId('tool-body')).toBeNull()
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
    expect(screen.getByTestId('tool-body')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('tool-header'))
    expect(screen.queryByTestId('tool-body')).toBeNull()
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
    expect(screen.getByTestId('tool-body')).toBeInTheDocument()
  })

  it('header 文件路径为可点击链接，且点击不触发展开', () => {
    const openFile = vi.fn()
    render(
      <SelectionWrapper openFile={openFile}>
        <ToolBlock block={toolBlock({ tool: 'read', input: { path: 'src/a.ts' } })} />
      </SelectionWrapper>,
    )
    const link = screen.getByTestId('filepath-link')
    expect(link.textContent).toBe('src/a.ts')
    // 折叠态点击路径：打开预览但不展开
    fireEvent.click(link)
    expect(openFile).toHaveBeenCalledWith('src/a.ts')
    expect(screen.getByTestId('tool-header').getAttribute('data-expanded')).toBe('false')
  })

  it('header 内嵌文件路径链接按 Enter/Space 不被折叠逻辑吞掉', () => {
    render(
      <SelectionWrapper>
        <ToolBlock block={toolBlock({ tool: 'read', input: { path: 'src/a.ts' } })} />
      </SelectionWrapper>,
    )
    const link = screen.getByTestId('filepath-link')
    const header = screen.getByTestId('tool-header')
    expect(header.getAttribute('data-expanded')).toBe('false')
    // fireEvent 返回 false 表示事件被 preventDefault——那会吃掉 <button> 自身的
    // Enter/Space 激活，文件预览键盘打不开。同时折叠态必须保持不变。
    expect(fireEvent.keyDown(link, { key: 'Enter' })).toBe(true)
    expect(fireEvent.keyDown(link, { key: ' ' })).toBe(true)
    expect(header.getAttribute('data-expanded')).toBe('false')
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

  // 失败原因与「等待权限确认」只存在于展开态：此前的自动收起把两者一起折叠了，
  // 消息流里只剩一个 ✗ / 🔒 图标，用户既看不到原因、也不知道工具在等谁点确认。
  it('error 默认展开，直接显示失败原因', () => {
    render(
      <ToolBlock
        block={toolBlock({
          status: 'error',
          output: { _tag: 'error', error: '文件不存在: /tmp/nope.ts' },
        })}
      />,
    )
    expect(screen.getByTestId('tool-header').getAttribute('data-expanded')).toBe('true')
    expect(screen.getByTestId('tool-error')).toHaveTextContent('文件不存在: /tmp/nope.ts')
  })

  it('running → error 不自动收起', () => {
    const { rerender } = render(<ToolBlock block={toolBlock({ status: 'running' })} />)
    rerender(
      <ToolBlock
        block={toolBlock({ status: 'error', output: { _tag: 'error', error: '权限不足' } })}
      />,
    )
    expect(screen.getByTestId('tool-header').getAttribute('data-expanded')).toBe('true')
    expect(screen.getByTestId('tool-error')).toHaveTextContent('权限不足')
  })

  it('paused 默认展开并说明在等权限确认', () => {
    render(<ToolBlock block={toolBlock({ status: 'paused' })} />)
    expect(screen.getByTestId('tool-header').getAttribute('data-expanded')).toBe('true')
    expect(screen.getByTestId('tool-body')).toHaveTextContent('等待权限确认')
  })
})
