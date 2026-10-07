// FileTree 组件测试，对应 src/web/components/FileTree.tsx
// 归并建议：FileTree 为 DirectoryPicker 的子组件，独立测试其递归渲染/展开/选中交互。
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TreeNode } from '@/components/FileTree.js'
import { FileTree } from '@/components/FileTree.js'

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

  it('暴露 tree/treeitem aria 语义（label/level/selected）', () => {
    const fileTree: TreeNode = {
      name: 'root',
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
        expanded={new Set(['.', 'src'])}
        selected="src/b.ts"
        loadingPaths={new Set()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        directoryClickMode="toggle"
        label="项目文件树"
        hideRoot
      />,
    )
    // tree 容器带 aria-label（可传入，默认「文件树」）
    expect(screen.getByRole('tree', { name: '项目文件树' })).toBeInTheDocument()
    // 顶层 treeitem aria-level=1；嵌套 treeitem aria-level 逐层递增
    const topNode = screen.getByTestId('node-a.ts').closest('[role="treeitem"]')
    expect(topNode?.getAttribute('aria-level')).toBe('1')
    const srcNode = screen.getByTestId('node-src').closest('[role="treeitem"]')
    expect(srcNode?.getAttribute('aria-level')).toBe('1')
    const bNode = screen.getByTestId('node-src/b.ts').closest('[role="treeitem"]')
    expect(bNode?.getAttribute('aria-level')).toBe('2')
    // aria-selected 反映选中态
    expect(bNode?.getAttribute('aria-selected')).toBe('true')
    expect(topNode?.getAttribute('aria-selected')).toBe('false')
  })

  it('嵌套 treeitem 归属于 role=group 容器', () => {
    const fileTree: TreeNode = {
      name: 'root',
      path: '.',
      type: 'directory',
      children: [
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
        expanded={new Set(['.', 'src'])}
        selected={null}
        loadingPaths={new Set()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        directoryClickMode="toggle"
        hideRoot
      />,
    )
    // aria-level=2 的节点必须落在 group 内，否则读屏/AT 得到的是一棵
    // 「所有子项平铺」的树，层级关系丢失。
    const child = screen.getByTestId('node-src/b.ts').closest('[role="treeitem"]')
    expect(child?.closest('[role="group"]')).toBeTruthy()
  })

  it('漫游 tabindex：整棵树只有一个可 Tab 进入的节点，方向键在节点间移动', () => {
    const fileTree: TreeNode = {
      name: 'root',
      path: '.',
      type: 'directory',
      children: [
        { name: 'a.ts', path: 'a.ts', type: 'file' },
        { name: 'b.ts', path: 'b.ts', type: 'file' },
        { name: 'c.ts', path: 'c.ts', type: 'file' },
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
    const treeitems = screen.getAllByRole('treeitem')
    const paths = treeitems.map((el) => (el as HTMLElement).dataset.path)

    // 此前所有 treeitem 一律 tabIndex=-1 且无方向键处理：容器声明了
    // role=tree，键盘却完全进不去（Tab 只经过行内的展开/@/删除按钮）。
    expect(treeitems.filter((el) => el.getAttribute('tabindex') === '0')).toHaveLength(1)
    expect(treeitems.filter((el) => el.getAttribute('tabindex') === '0')[0]).toHaveAttribute(
      'data-path',
      'a.ts',
    )

    const current = () =>
      screen
        .getAllByRole('treeitem')
        .find((el) => el.getAttribute('tabindex') === '0')
        ?.getAttribute('data-path')

    const first = treeitems[0]
    first?.focus()
    fireEvent.keyDown(first as HTMLElement, { key: 'ArrowDown' })
    expect(current()).toBe(paths[1])
    fireEvent.keyDown(first as HTMLElement, { key: 'ArrowDown' })
    expect(current()).toBe(paths[2])
    // 末尾不越界
    fireEvent.keyDown(first as HTMLElement, { key: 'ArrowDown' })
    expect(current()).toBe(paths[2])
    fireEvent.keyDown(first as HTMLElement, { key: 'ArrowUp' })
    expect(current()).toBe(paths[1])
    fireEvent.keyDown(first as HTMLElement, { key: 'Home' })
    expect(current()).toBe(paths[0])
    fireEvent.keyDown(first as HTMLElement, { key: 'End' })
    expect(current()).toBe(paths[2])
  })

  it('点击（或程序化聚焦）某个节点后，方向键从该节点继续而不是回到旧位置', () => {
    const fileTree: TreeNode = {
      name: 'root',
      path: '.',
      type: 'directory',
      children: [
        { name: 'a.ts', path: 'a.ts', type: 'file' },
        { name: 'b.ts', path: 'b.ts', type: 'file' },
        { name: 'c.ts', path: 'c.ts', type: 'file' },
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
    const current = () =>
      screen
        .getAllByRole('treeitem')
        .find((el) => el.getAttribute('tabindex') === '0')
        ?.getAttribute('data-path')

    // 初始漫游点在首项；用户直接点中间那一行（DOM 焦点进入该节点）
    expect(current()).toBe('a.ts')
    const middle = screen.getByTestId('node-b.ts').closest('[role="treeitem"]') as HTMLElement
    fireEvent.focus(middle)
    expect(current()).toBe('b.ts')

    // 方向键必须从这个节点继续，否则会从 a.ts 跳到 c.ts，用户看到「跳了一格」
    fireEvent.keyDown(middle, { key: 'ArrowDown' })
    expect(current()).toBe('c.ts')
    fireEvent.keyDown(middle, { key: 'ArrowUp' })
    expect(current()).toBe('b.ts')
  })

  it('折叠目录后被折叠的子节点不再占用方向键停留位', () => {
    const fileTree: TreeNode = {
      name: 'root',
      path: '.',
      type: 'directory',
      children: [
        { name: 'a.ts', path: 'a.ts', type: 'file' },
        {
          name: 'src',
          type: 'directory',
          path: 'src',
          children: [{ name: 'b.ts', path: 'src/b.ts', type: 'file' }],
        },
      ],
    }
    const { rerender } = render(
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
    const count = () => screen.getAllByRole('treeitem').length
    expect(count()).toBe(2)

    rerender(
      <FileTree
        root={fileTree}
        expanded={new Set(['.', 'src'])}
        selected={null}
        loadingPaths={new Set()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        directoryClickMode="toggle"
        hideRoot
      />,
    )
    expect(count()).toBe(3)
  })

  it('未传 label 时 tree 使用默认 aria-label「文件树」', () => {
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
    expect(screen.getByRole('tree', { name: '文件树' })).toBeInTheDocument()
  })
})
