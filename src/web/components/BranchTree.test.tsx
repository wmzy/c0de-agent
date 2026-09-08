import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionTreeNode } from '../types/index.js'
import { BranchTree } from './BranchTree.js'

afterEach(() => cleanup())

const tree: SessionTreeNode[] = [
  {
    session: {
      id: 's1',
      title: 'Root',
      parentId: null,
      projectId: null,
      branchPoint: null,
      metadata: {},
      agentType: null,
      worktreePath: null,
      source: null,
      deletedAt: null,
      createdAt: 1,
      updatedAt: 1,
    },
    children: [
      {
        session: {
          id: 's2',
          title: 'Child',
          parentId: 's1',
          projectId: null,
          branchPoint: 0,
          metadata: {},
          agentType: null,
          worktreePath: null,
          source: null,
          deletedAt: null,
          createdAt: 1,
          updatedAt: 1,
        },
        children: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cost: 0, calls: 0 },
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cost: 0, calls: 0 },
  },
]

const treeWithUsage: SessionTreeNode[] = [
  {
    session: {
      id: 's1',
      title: 'Root',
      parentId: null,
      projectId: null,
      branchPoint: null,
      metadata: {},
      agentType: null,
      worktreePath: null,
      source: null,
      deletedAt: null,
      createdAt: 1,
      updatedAt: 1,
    },
    children: [],
    usage: { inputTokens: 12000, outputTokens: 3000, cacheRead: 500, cost: 0.03, calls: 8 },
  },
]

describe('BranchTree', () => {
  it('递归渲染父子节点', () => {
    render(<BranchTree nodes={tree} activeId="s1" onSelect={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByTestId('node-s1')).toBeTruthy()
    expect(screen.getByTestId('node-s2')).toBeTruthy()
  })

  it('点击节点回调 id', () => {
    const onSelect = vi.fn()
    render(<BranchTree nodes={tree} activeId={null} onSelect={onSelect} onDelete={vi.fn()} />)
    fireEvent.click(screen.getByTestId('node-s2'))
    expect(onSelect).toHaveBeenCalledWith('s2')
  })

  it('每行渲染删除按钮', () => {
    render(<BranchTree nodes={tree} activeId="s1" onSelect={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByTestId('delete-s1')).toBeTruthy()
    expect(screen.getByTestId('delete-s2')).toBeTruthy()
  })

  it('点击删除按钮回调该会话 id 且不触发选择', () => {
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    render(<BranchTree nodes={tree} activeId={null} onSelect={onSelect} onDelete={onDelete} />)
    fireEvent.click(screen.getByTestId('delete-s2'))
    expect(onDelete).toHaveBeenCalledWith('s2')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('有调用记录的会话行显示累计 token 徽标，空用量不渲染', () => {
    render(
      <BranchTree nodes={treeWithUsage} activeId={null} onSelect={vi.fn()} onDelete={vi.fn()} />,
    )
    expect(screen.getByTestId('usage-badge').textContent).toContain('15,500')
    cleanup()
    render(<BranchTree nodes={tree} activeId={null} onSelect={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.queryByTestId('usage-badge')).toBeNull()
  })
})
