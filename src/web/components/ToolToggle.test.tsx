/**
 * ToolToggle 组件测试。
 * 归并建议：本文件为新增「输入区工具开关」组件的单元测试，与 InputArea.test.tsx
 * 同属「输入区交互」组件族；若后续合并输入区组件，可并入对应测试文件。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import type { Mock } from 'vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolListItem } from '../types/index.js'
import { ToolToggle } from './ToolToggle.js'

vi.mock('../services/tool.js', () => ({
  toolAPI: { list: vi.fn() },
}))

const { toolAPI } = await import('../services/tool.js')

const TOOLS: ToolListItem[] = [
  { name: 'read', description: '读取文件', parameters: {}, permission: {} },
  { name: 'bash', description: '执行命令', parameters: {}, permission: {} },
  { name: 'edit', description: '编辑文件', parameters: {}, permission: {} },
]

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

/** 回写 onChange 的受控包装，用于测试连续交互闭环。 */
function StatefulToggle({ initial }: { initial: Set<string> | null }) {
  const [value, setValue] = useState<Set<string> | null>(initial)
  return <ToolToggle enabled={value} onChange={setValue} />
}

function mockTools(list: ToolListItem[] = TOOLS) {
  ;(toolAPI.list as Mock).mockResolvedValue(list)
}

function openMenu() {
  fireEvent.click(screen.getByTestId('tool-toggle'))
}

describe('ToolToggle', () => {
  it('默认（null）显示「全部」徽章', async () => {
    mockTools()
    renderWithClient(<ToolToggle enabled={null} onChange={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('tool-toggle').textContent).toContain('全部')
    })
  })

  it('部分启用显示 N/M 徽章', async () => {
    mockTools()
    renderWithClient(<ToolToggle enabled={new Set(['read'])} onChange={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('tool-toggle').textContent).toContain('1/3')
    })
  })

  it('全部禁用显示「已禁用」', async () => {
    mockTools()
    renderWithClient(<ToolToggle enabled={new Set()} onChange={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('tool-toggle').textContent).toContain('已禁用')
    })
  })

  it('点击触发按钮展开工具列表', async () => {
    mockTools()
    renderWithClient(<ToolToggle enabled={null} onChange={vi.fn()} />)
    await waitFor(() => expect(toolAPI.list).toHaveBeenCalled())
    expect(screen.queryByTestId('tool-menu')).toBeNull()
    openMenu()
    expect(screen.getByTestId('tool-menu')).toBeTruthy()
    expect(screen.getByTestId('tool-item-read')).toBeTruthy()
  })

  it('从默认全启用首次取消某工具，回调包含除该项外所有工具', async () => {
    mockTools()
    const onChange = vi.fn()
    renderWithClient(<ToolToggle enabled={null} onChange={onChange} />)
    await waitFor(() => expect(toolAPI.list).toHaveBeenCalled())
    openMenu()
    fireEvent.click(screen.getByTestId('tool-check-read'))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as Set<string>
    expect(next).toBeInstanceOf(Set)
    expect(next.has('read')).toBe(false)
    expect(next.has('bash')).toBe(true)
    expect(next.has('edit')).toBe(true)
    expect(next.size).toBe(2)
  })

  it('受控闭环：连续增删正确反映到勾选状态', async () => {
    mockTools()
    renderWithClient(<StatefulToggle initial={new Set(['read', 'bash'])} />)
    await waitFor(() => expect(toolAPI.list).toHaveBeenCalled())
    openMenu()
    const editCheck = screen.getByTestId('tool-check-edit') as HTMLInputElement
    const bashCheck = screen.getByTestId('tool-check-bash') as HTMLInputElement
    // 初始：edit 未勾选
    expect(editCheck.checked).toBe(false)
    // 启用 edit
    fireEvent.click(editCheck)
    expect(editCheck.checked).toBe(true)
    // 取消 bash
    expect(bashCheck.checked).toBe(true)
    fireEvent.click(bashCheck)
    expect(bashCheck.checked).toBe(false)
  })

  it('全选按钮恢复为 null（默认全启用）', async () => {
    mockTools()
    const onChange = vi.fn()
    renderWithClient(<ToolToggle enabled={new Set(['read'])} onChange={onChange} />)
    await waitFor(() => expect(toolAPI.list).toHaveBeenCalled())
    openMenu()
    fireEvent.click(screen.getByTestId('tool-select-all'))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('清除按钮回空集合', async () => {
    mockTools()
    const onChange = vi.fn()
    renderWithClient(<ToolToggle enabled={null} onChange={onChange} />)
    await waitFor(() => expect(toolAPI.list).toHaveBeenCalled())
    openMenu()
    fireEvent.click(screen.getByTestId('tool-clear'))
    const next = onChange.mock.calls[0]?.[0] as Set<string>
    expect(next).toBeInstanceOf(Set)
    expect(next.size).toBe(0)
  })

  it('点击组件外关闭弹层', async () => {
    mockTools()
    renderWithClient(
      <div data-testid="outside">
        <ToolToggle enabled={null} onChange={vi.fn()} />
      </div>,
    )
    await waitFor(() => expect(toolAPI.list).toHaveBeenCalled())
    openMenu()
    expect(screen.getByTestId('tool-menu')).toBeTruthy()
    // 在组件外部触发 mousedown
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(screen.queryByTestId('tool-menu')).toBeNull()
  })

  it('disabled 时按钮不可交互', () => {
    mockTools()
    renderWithClient(<ToolToggle enabled={null} onChange={vi.fn()} disabled />)
    const btn = screen.getByTestId('tool-toggle') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(screen.queryByTestId('tool-menu')).toBeNull()
  })
})
