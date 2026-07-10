import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkflowGraph, type WorkflowNode } from './WorkflowGraph.js'

afterEach(() => cleanup())

describe('WorkflowGraph', () => {
  it('renders root node with dispatcher label', () => {
    render(
      <WorkflowGraph
        nodes={[{ id: 't0', agentType: 'coder', label: 'Task', status: 'completed' }]}
        rootLabel="coder"
        rootStatus="completed"
      />,
    )
    expect(screen.getByText('coder')).toBeInTheDocument()
    expect(screen.getByText('dispatcher')).toBeInTheDocument()
  })

  it('renders all child nodes', () => {
    const nodes: WorkflowNode[] = [
      { id: 't0', agentType: 'coder', label: 'Implement auth', status: 'completed' },
      { id: 't1', agentType: 'coder', label: 'Implement signup', status: 'running' },
      { id: 't2', agentType: 'reviewer', label: 'Review code', status: 'pending' },
    ]
    render(<WorkflowGraph nodes={nodes} rootLabel="main" rootStatus="running" />)
    expect(screen.getByText('Implement auth')).toBeInTheDocument()
    expect(screen.getByText('Implement signup')).toBeInTheDocument()
    expect(screen.getByText('Review code')).toBeInTheDocument()
  })

  it('renders status indicators for each node', () => {
    const nodes: WorkflowNode[] = [
      { id: 't0', agentType: 'coder', label: 'Done', status: 'completed' },
      { id: 't1', agentType: 'coder', label: 'Running', status: 'running' },
      { id: 't2', agentType: 'coder', label: 'Failed', status: 'failed' },
      { id: 't3', agentType: 'coder', label: 'Waiting', status: 'pending' },
    ]
    render(<WorkflowGraph nodes={nodes} rootLabel="main" rootStatus="running" />)
    // 状态标签
    expect(screen.getByText(/已完成/)).toBeInTheDocument()
    expect(screen.getByText(/执行中/)).toBeInTheDocument()
    expect(screen.getByText(/失败/)).toBeInTheDocument()
    expect(screen.getByText(/待执行/)).toBeInTheDocument()
  })

  it('renders running status dot with animation', () => {
    render(
      <WorkflowGraph
        nodes={[{ id: 't0', agentType: 'coder', label: 'Task', status: 'running' }]}
        rootLabel="main"
        rootStatus="running"
      />,
    )
    const dots = screen.getAllByTestId('wf-dot-running')
    expect(dots.length).toBeGreaterThanOrEqual(1)
  })

  it('renders nothing when nodes array is empty', () => {
    const { container } = render(
      <WorkflowGraph nodes={[]} rootLabel="main" rootStatus="completed" />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders agent type for each child node', () => {
    const nodes: WorkflowNode[] = [
      { id: 't0', agentType: 'researcher', label: 'Investigate', status: 'completed' },
      { id: 't1', agentType: 'reviewer', label: 'Audit', status: 'running' },
    ]
    render(<WorkflowGraph nodes={nodes} rootLabel="main" rootStatus="running" />)
    // agentType 出现在 nodeMeta 行
    expect(screen.getAllByText(/researcher/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/reviewer/).length).toBeGreaterThanOrEqual(1)
  })
})
