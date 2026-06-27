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
      branchPoint: null,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
    children: [
      {
        session: {
          id: 's2',
          title: 'Child',
          parentId: 's1',
          branchPoint: 0,
          metadata: {},
          createdAt: 2,
          updatedAt: 2,
        },
        children: [],
      },
    ],
  },
]

describe('BranchTree', () => {
  it('递归渲染父子节点', () => {
    render(<BranchTree nodes={tree} activeId="s1" onSelect={vi.fn()} />)
    expect(screen.getByTestId('node-s1')).toBeTruthy()
    expect(screen.getByTestId('node-s2')).toBeTruthy()
  })

  it('点击节点回调 id', () => {
    const onSelect = vi.fn()
    render(<BranchTree nodes={tree} activeId={null} onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId('node-s2'))
    expect(onSelect).toHaveBeenCalledWith('s2')
  })
})
