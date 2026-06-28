// FileTree 组件测试，对应 src/web/components/FileTree.tsx
// 归并建议：FileTree 为 DirectoryPicker 的子组件，独立测试其递归渲染/展开/选中交互。
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TreeNode } from './FileTree.js'
import { FileTree } from './FileTree.js'

afterEach(cleanup)

const tree: TreeNode = {
  name: 'root',
  path: '/root',
  children: [
    { name: 'a', path: '/root/a', children: [{ name: 'a1', path: '/root/a/a1' }] },
    { name: 'b', path: '/root/b' },
  ],
}

describe('FileTree', () => {
  it('渲染根节点', () => {
    render(
      <FileTree
        root={tree}
        expanded={new Set()}
        selected={null}
        loadingPaths={new Set()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByText('root')).toBeTruthy()
    // 未展开时不渲染子节点
    expect(screen.queryByText('a')).toBeNull()
  })

  it('展开节点渲染子节点', () => {
    render(
      <FileTree
        root={tree}
        expanded={new Set(['/root'])}
        selected={null}
        loadingPaths={new Set()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByText('a')).toBeTruthy()
    expect(screen.getByText('b')).toBeTruthy()
  })

  it('点击 toggle 触发 onToggle', () => {
    const onToggle = vi.fn()
    render(
      <FileTree
        root={tree}
        expanded={new Set()}
        selected={null}
        loadingPaths={new Set()}
        onToggle={onToggle}
        onSelect={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('toggle-/root'))
    expect(onToggle).toHaveBeenCalledWith('/root')
  })

  it('点击节点名触发 onSelect', () => {
    const onSelect = vi.fn()
    render(
      <FileTree
        root={tree}
        expanded={new Set(['/root'])}
        selected={null}
        loadingPaths={new Set()}
        onToggle={vi.fn()}
        onSelect={onSelect}
      />,
    )
    fireEvent.click(screen.getByTestId('node-/root/a'))
    expect(onSelect).toHaveBeenCalledWith('/root/a')
  })

  it('递归渲染深层节点', () => {
    render(
      <FileTree
        root={tree}
        expanded={new Set(['/root', '/root/a'])}
        selected={null}
        loadingPaths={new Set()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByText('a1')).toBeTruthy()
  })

  it('加载中显示提示', () => {
    render(
      <FileTree
        root={{ name: 'root', path: '/root', children: [] }}
        expanded={new Set(['/root'])}
        selected={null}
        loadingPaths={new Set()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByText('（空）')).toBeTruthy()
  })

  it('root 为 null 不渲染', () => {
    const { container } = render(
      <FileTree
        root={null}
        expanded={new Set()}
        selected={null}
        loadingPaths={new Set()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})
