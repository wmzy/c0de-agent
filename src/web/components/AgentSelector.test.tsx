import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentListItem } from '../services/agent.js'
import { AgentSelector } from './AgentSelector.js'

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
})
