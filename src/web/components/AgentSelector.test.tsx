import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentSelector } from '@/components/AgentSelector.js'
import type { AgentListItem } from '@/services/agent.js'

afterEach(() => {
  cleanup()
})

const agents: AgentListItem[] = [
  { name: 'default', description: '通用', mode: 'primary', source: 'builtin', hasTools: false },
  { name: 'plan', description: '计划', mode: 'primary', source: 'builtin', hasTools: true },
  { name: 'coder', description: '编码', mode: 'subagent', source: 'builtin', hasTools: true },
]

describe('AgentSelector', () => {
  it('只渲染 primary agent（过滤 subagent）', () => {
    render(<AgentSelector value="default" onChange={vi.fn()} agents={agents} />)
    const select = screen.getByRole('combobox')
    const options = within(select).getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(select).toHaveValue('default')
  })

  it('切换时调用 onChange', async () => {
    const onChange = vi.fn()
    render(<AgentSelector value="default" onChange={onChange} agents={agents} />)
    const select = screen.getByRole('combobox')
    await userEvent.selectOptions(select, 'plan')
    expect(onChange).toHaveBeenCalledWith('plan')
  })

  // 回归：GET /api/agents 失败（服务重启窗口 / 500 / 断连）时，此前会渲染出一个
  // 零 option 的空下拉——与「一个 agent 都没有」完全同形：用户看不到当前 agent
  // （后端其实仍以它执行），无法切换，页面上没有原因也没有重试。
  it('清单读取失败时给出原因与重试，不再渲染空下拉', async () => {
    const onRetry = vi.fn()
    render(
      <AgentSelector
        value="default"
        onChange={vi.fn()}
        agents={[]}
        error={new Error('db locked')}
        onRetry={onRetry}
      />,
    )
    const notice = screen.getByTestId('agent-selector-load-error')
    expect(notice.getAttribute('role')).toBe('alert')
    expect(notice.textContent).toContain('agent 列表读取失败')
    expect(notice.textContent).toContain('db locked')
    expect(screen.queryByRole('combobox')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('读取正常时仍渲染下拉（不因新增失败分支改变成功路径）', () => {
    render(<AgentSelector value="plan" onChange={vi.fn()} agents={agents} error={null} />)
    expect(screen.getByRole('combobox')).toHaveValue('plan')
    expect(screen.queryByTestId('agent-selector-load-error')).toBeNull()
  })
})
