// FileTree 组件测试，对应 src/web/components/FileTree.tsx
// 归并建议：FileTree 为 DirectoryPicker 的子组件，独立测试其递归渲染/展开/选中交互。
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TreeNode } from './FileTree.js'
import { FileTree } from './FileTree.js'

afterEach(cleanup)

/** 取元素最近的 [data-git-status] 容器的状态值。 */
function gitStatusOf(text: string): string | null {
  return (
    screen.getByText(text).closest('[data-git-status]')?.getAttribute('data-git-status') ?? null
  )
}

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

  it('传入 onMention 时文件和目录节点都渲染 @ 按钮，点击调用', () => {
    const onMention = vi.fn()
    const fileTree: TreeNode = {
      name: 'root',
      path: '/root',
      children: [
        { name: 'a.ts', path: '/root/a.ts', type: 'file' },
        { name: 'dir', path: '/root/dir', type: 'directory', children: [] },
      ],
    }
    render(
      <FileTree
        root={fileTree}
        expanded={new Set(['/root'])}
        selected={null}
        loadingPaths={new Set()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        directoryClickMode="toggle"
        onMention={onMention}
      />,
    )
    // 文件节点有 @ 按钮
    expect(screen.getByTestId('mention-/root/a.ts')).toBeTruthy()
    // 目录节点也有 @ 按钮
    expect(screen.getByTestId('mention-/root/dir')).toBeTruthy()
    // 点击文件的 @ 调用 onMention
    fireEvent.click(screen.getByTestId('mention-/root/a.ts'))
    expect(onMention).toHaveBeenCalledWith('/root/a.ts')
    // 点击目录的 @ 调用 onMention
    fireEvent.click(screen.getByTestId('mention-/root/dir'))
    expect(onMention).toHaveBeenCalledWith('/root/dir')
  })

  it('未传入 onMention 时不渲染 @ 按钮', () => {
    render(
      <FileTree
        root={{
          name: 'root',
          path: '/root',
          children: [{ name: 'a.ts', path: '/root/a.ts', type: 'file' }],
        }}
        expanded={new Set(['/root'])}
        selected={null}
        loadingPaths={new Set()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('mention-/root/a.ts')).toBeNull()
  })

  it('传入 gitStatusMap 时文件节点按状态高亮', () => {
    const onMention = vi.fn()
    const fileTree: TreeNode = {
      name: 'root',
      path: '.',
      children: [
        { name: 'modified.ts', path: 'modified.ts', type: 'file' },
        { name: 'staged.ts', path: 'staged.ts', type: 'file' },
        { name: 'untracked.ts', path: 'untracked.ts', type: 'file' },
        { name: 'clean.ts', path: 'clean.ts', type: 'file' },
      ],
    }
    render(
      <FileTree
        root={fileTree}
        expanded={new Set(['.'])}
        selected={null}
        loadingPaths={new Set()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        directoryClickMode="toggle"
        onMention={onMention}
        gitStatusMap={{
          'modified.ts': 'modified',
          'staged.ts': 'staged',
          'untracked.ts': 'untracked',
        }}
      />,
    )
    expect(gitStatusOf('modified.ts')).toBe('modified')
    expect(gitStatusOf('staged.ts')).toBe('staged')
    expect(gitStatusOf('untracked.ts')).toBe('untracked')
    // 无状态文件不带 data-git-status
    expect(gitStatusOf('clean.ts')).toBeNull()
  })

  it('目录节点按后代最高优先级状态聚合高亮', () => {
    const fileTree: TreeNode = {
      name: 'root',
      path: '.',
      children: [
        {
          name: 'src',
          path: 'src',
          type: 'directory',
          children: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' }],
        },
      ],
    }
    render(
      <FileTree
        root={fileTree}
        expanded={new Set(['.', 'src'])}
        selected={null}
        loadingPaths={new Set()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        directoryClickMode="toggle"
        gitStatusMap={{ 'src/a.ts': 'modified' }}
      />,
    )
    // src 目录应聚合为 modified
    expect(gitStatusOf('src')).toBe('modified')
    // 子文件直接为 modified
    expect(gitStatusOf('a.ts')).toBe('modified')
  })

  it('节点 ignored 属性驱动灰显（data-ignored）', () => {
    const fileTree: TreeNode = {
      name: 'root',
      path: '.',
      children: [
        { name: 'ignored.txt', path: 'ignored.txt', type: 'file', ignored: true },
        { name: 'normal.txt', path: 'normal.txt', type: 'file' },
        {
          name: 'build',
          path: 'build',
          type: 'directory',
          ignored: true,
          children: [{ name: 'out.js', path: 'build/out.js', type: 'file' }],
        },
      ],
    }
    render(
      <FileTree
        root={fileTree}
        expanded={new Set(['.', 'build'])}
        selected={null}
        loadingPaths={new Set()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        directoryClickMode="toggle"
      />,
    )
    // ignored 文件带 data-ignored
    expect(screen.getByText('ignored.txt').closest('[data-ignored]')).toBeTruthy()
    // 正常文件不带
    expect(screen.getByText('normal.txt').closest('[data-ignored]')).toBeNull()
    // ignored 目录带 data-ignored
    expect(screen.getByText('build').closest('[data-ignored]')).toBeTruthy()
  })

  it('hideRoot 时不渲染根节点本身，直接渲染子项', () => {
    const fileTree: TreeNode = {
      name: 'my-project',
      path: '.',
      type: 'directory',
      children: [
        { name: 'a.ts', path: 'a.ts', type: 'file' },
        {
          name: 'src',
          path: 'src',
          type: 'directory',
          children: [{ name: 'b.ts', path: 'src/b.ts', type: 'file' }],
        },
      ],
    }
    render(
      <FileTree
        root={fileTree}
        expanded={new Set(['.'])}
        selected={null}
        loadingPaths={new Set()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        directoryClickMode="toggle"
        hideRoot
      />,
    )
    // 根节点（项目名）不渲染
    expect(screen.queryByText('my-project')).toBeNull()
    // 子项直接出现在顶层
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.getByText('src')).toBeInTheDocument()
  })
})
