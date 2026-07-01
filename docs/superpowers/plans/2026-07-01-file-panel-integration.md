# 文件浏览/预览/编辑集成到主界面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已有的孤立组件（FileBrowser/FilePreview/CodeEditor）接入 ChatPage 主界面——sidebar 加会话/文件 Tab，选中文件在右侧 panel 预览，对话流中工具路径可点击打开预览。

**Architecture:** 新建 `FileSelectionContext`（ChatPage 持有 `selectedFile` 状态，通过 context 下发 `openFile`/`closeFile`）。`SidebarTabs` 切换 SessionList/FileBrowser。`FilePathLink` 包装工具路径，点击调 `openFile`。Layout 已有 `panel` 槽（360px 桌面端），无需改 Layout。

**Tech Stack:** React 19, TypeScript, Linaria (CSS-in-JS), Vitest, @testing-library/react

**Spec:** `docs/superpowers/specs/2026-07-01-file-panel-integration-design.md`

---

## File Map

| 文件 | 责任 | 改动类型 |
|------|------|---------|
| `src/web/contexts/FileSelectionContext.tsx` | context + hook + 类型 | Create |
| `src/web/components/FilePathLink.tsx` | 可点击文件路径链接 | Create |
| `src/web/components/SidebarTabs.tsx` | 会话/文件 tab 切换器 | Create |
| `src/web/views/FilePreview.tsx` | 加 header + 关闭按钮 | Rewrite |
| `src/web/components/session/tools/ReadToolView.tsx` | path → FilePathLink | Modify |
| `src/web/components/session/tools/EditToolView.tsx` | path → FilePathLink | Modify |
| `src/web/components/session/tools/WriteToolView.tsx` | path → FilePathLink | Modify |
| `src/web/App.tsx` | ChatPage 接入 Provider + panel + SidebarTabs | Modify |

---

## Task 1: FileSelectionContext

**Files:**
- Create: `src/web/contexts/FileSelectionContext.tsx`
- Test: `src/web/contexts/FileSelectionContext.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `src/web/contexts/FileSelectionContext.test.tsx`：

```tsx
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSelectionContext, useFileSelection } from './FileSelectionContext.js'

afterEach(cleanup)

// 消费 hook 的测试组件
function Consumer() {
  const { selectedFile, openFile, closeFile } = useFileSelection()
  return (
    <div>
      <span data-testid="selected">{selectedFile ?? 'null'}</span>
      <button type="button" onClick={() => openFile('src/a.ts')} data-testid="open">
        open
      </button>
      <button type="button" onClick={closeFile} data-testid="close">
        close
      </button>
    </div>
  )
}

describe('FileSelectionContext', () => {
  it('无 Provider 时 useFileSelection 抛错', () => {
    // 抑制 console.error（React Provider 缺失会打印）
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Consumer />)).toThrow('useFileSelection must be used within FileSelectionContext')
    spy.mockRestore()
  })

  it('Provider 提供 openFile/closeFile/selectedFile', () => {
    render(
      <FileSelectionContext.Provider
        value={{
          selectedFile: null,
          openFile: () => {},
          closeFile: () => {},
        }}
      >
        <Consumer />
      </FileSelectionContext.Provider>,
    )
    expect(screen.getByTestId('selected').textContent).toBe('null')
  })

  it('openFile 更新 selectedFile（通过 Provider 内 state 驱动）', () => {
    function Wrapper() {
      const [f, setF] = useState<string | null>(null)
      return (
        <FileSelectionContext.Provider
          value={{ selectedFile: f, openFile: setF, closeFile: () => setF(null) }}
        >
          <Consumer />
        </FileSelectionContext.Provider>
      )
    }
    render(<Wrapper />)
    expect(screen.getByTestId('selected').textContent).toBe('null')
    fireEvent.click(screen.getByTestId('open'))
    expect(screen.getByTestId('selected').textContent).toBe('src/a.ts')
    fireEvent.click(screen.getByTestId('close'))
    expect(screen.getByTestId('selected').textContent).toBe('null')
  })
})
```

在文件顶部 import 补充 `useState`（从 react）和 `fireEvent`（从 @testing-library/react）：

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/web/contexts/FileSelectionContext.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 context**

创建 `src/web/contexts/FileSelectionContext.tsx`：

```tsx
import { createContext, useContext } from 'react'

/** 文件选中状态：ChatPage 持有，通过 context 下发给 ToolView 和 panel。 */
export type FileSelection = {
  /** 当前选中的文件路径；null 时 panel 不渲染。 */
  selectedFile: string | null
  /** 打开文件预览（设置 selectedFile）。 */
  openFile: (path: string) => void
  /** 关闭文件预览（清空 selectedFile）。 */
  closeFile: () => void
}

export const FileSelectionContext = createContext<FileSelection | null>(null)

/** 消费文件选中状态；Provider 缺失时抛错（避免静默失灵）。 */
export function useFileSelection(): FileSelection {
  const ctx = useContext(FileSelectionContext)
  if (!ctx) throw new Error('useFileSelection must be used within FileSelectionContext')
  return ctx
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/web/contexts/FileSelectionContext.test.tsx`
Expected: PASS（3 个测试全过）

- [ ] **Step 5: Commit**

```bash
git add src/web/contexts/FileSelectionContext.tsx src/web/contexts/FileSelectionContext.test.tsx
git commit -m "feat(web): FileSelectionContext — 文件选中状态下发"
```

---

## Task 2: FilePathLink 组件

**Files:**
- Create: `src/web/components/FilePathLink.tsx`
- Test: `src/web/components/FilePathLink.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `src/web/components/FilePathLink.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSelectionContext } from '../contexts/FileSelectionContext.js'
import { FilePathLink } from './FilePathLink.js'

afterEach(cleanup)

// 用假 Provider 包裹，捕获 openFile 调用
function withSelection(ui: React.ReactNode, openFile = vi.fn()) {
  render(
    <FileSelectionContext.Provider
      value={{ selectedFile: null, openFile, closeFile: () => {} }}
    >
      {ui}
    </FileSelectionContext.Provider>,
  )
  return openFile
}

describe('FilePathLink', () => {
  it('渲染路径文本', () => {
    withSelection(<FilePathLink path="src/a.ts" />)
    expect(screen.getByText('src/a.ts')).toBeTruthy()
  })

  it('点击调用 openFile', () => {
    const openFile = withSelection(<FilePathLink path="src/a.ts" />)
    fireEvent.click(screen.getByText('src/a.ts'))
    expect(openFile).toHaveBeenCalledWith('src/a.ts')
  })

  it('有 title 属性提示', () => {
    withSelection(<FilePathLink path="src/a.ts" />)
    expect(screen.getByText('src/a.ts').getAttribute('title')).toContain('src/a.ts')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/web/components/FilePathLink.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 FilePathLink**

创建 `src/web/components/FilePathLink.tsx`：

```tsx
import { css } from '@linaria/core'
import { useFileSelection } from '../contexts/FileSelectionContext.js'

const link = css`
  color: var(--primary);
  background: transparent;
  border: none;
  padding: 0;
  font: inherit;
  cursor: pointer;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
`

/** 可点击文件路径：点击后在右侧 panel 打开预览。 */
export function FilePathLink({ path }: { path: string }) {
  const { openFile } = useFileSelection()
  return (
    <button
      type="button"
      className={link}
      onClick={() => openFile(path)}
      title={`预览 ${path}`}
      data-testid="filepath-link"
    >
      {path}
    </button>
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/web/components/FilePathLink.test.tsx`
Expected: PASS（3 个测试全过）

- [ ] **Step 5: Commit**

```bash
git add src/web/components/FilePathLink.tsx src/web/components/FilePathLink.test.tsx
git commit -m "feat(web): FilePathLink 可点击文件路径"
```

---

## Task 3: SidebarTabs 组件

**Files:**
- Create: `src/web/components/SidebarTabs.tsx`
- Test: `src/web/components/SidebarTabs.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `src/web/components/SidebarTabs.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarTabs } from './SidebarTabs.js'

afterEach(cleanup)

describe('SidebarTabs', () => {
  it('渲染两个 tab 按钮', () => {
    render(
      <SidebarTabs
        activeTab="sessions"
        onSwitch={() => {}}
        sessions={<div data-testid="sessions-content">会话</div>}
        files={<div data-testid="files-content">文件</div>}
      />,
    )
    expect(screen.getByText('💬会话')).toBeTruthy()
    expect(screen.getByText('📁文件')).toBeTruthy()
  })

  it('activeTab=sessions 渲染会话内容', () => {
    render(
      <SidebarTabs
        activeTab="sessions"
        onSwitch={() => {}}
        sessions={<div data-testid="sessions-content">会话</div>}
        files={<div data-testid="files-content">文件</div>}
      />,
    )
    expect(screen.getByTestId('sessions-content')).toBeTruthy()
    expect(screen.queryByTestId('files-content')).toBeNull()
  })

  it('activeTab=files 渲染文件内容', () => {
    render(
      <SidebarTabs
        activeTab="files"
        onSwitch={() => {}}
        sessions={<div data-testid="sessions-content">会话</div>}
        files={<div data-testid="files-content">文件</div>}
      />,
    )
    expect(screen.getByTestId('files-content')).toBeTruthy()
    expect(screen.queryByTestId('sessions-content')).toBeNull()
  })

  it('点击 tab 调用 onSwitch', () => {
    const onSwitch = vi.fn()
    render(
      <SidebarTabs
        activeTab="sessions"
        onSwitch={onSwitch}
        sessions={<div />}
        files={<div />}
      />,
    )
    fireEvent.click(screen.getByText('📁文件'))
    expect(onSwitch).toHaveBeenCalledWith('files')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/web/components/SidebarTabs.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 SidebarTabs**

创建 `src/web/components/SidebarTabs.tsx`：

```tsx
import { css } from '@linaria/core'
import type { ReactNode } from 'react'

export type SidebarTab = 'sessions' | 'files'

const container = css`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
`

const tabBar = css`
  display: flex;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
`

const tab = css`
  flex: 1;
  padding: 6px 8px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    color: var(--text);
  }
`

const tabActive = css`
  color: var(--primary);
  border-bottom-color: var(--primary);
`

const content = css`
  flex: 1;
  overflow: auto;
  min-height: 0;
`

type SidebarTabsProps = {
  activeTab: SidebarTab
  onSwitch: (t: SidebarTab) => void
  sessions: ReactNode
  files: ReactNode
}

/** 会话/文件侧栏切换器：顶部两 tab，下方渲染对应内容。 */
export function SidebarTabs({ activeTab, onSwitch, sessions, files }: SidebarTabsProps) {
  return (
    <div className={container}>
      <div className={tabBar}>
        <button
          type="button"
          className={`${tab} ${activeTab === 'sessions' ? tabActive : ''}`}
          onClick={() => onSwitch('sessions')}
          data-testid="tab-sessions"
        >
          💬会话
        </button>
        <button
          type="button"
          className={`${tab} ${activeTab === 'files' ? tabActive : ''}`}
          onClick={() => onSwitch('files')}
          data-testid="tab-files"
        >
          📁文件
        </button>
      </div>
      <div className={content}>{activeTab === 'sessions' ? sessions : files}</div>
    </div>
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/web/components/SidebarTabs.test.tsx`
Expected: PASS（4 个测试全过）

- [ ] **Step 5: Commit**

```bash
git add src/web/components/SidebarTabs.tsx src/web/components/SidebarTabs.test.tsx
git commit -m "feat(web): SidebarTabs 会话/文件侧栏切换器"
```

---

## Task 4: FilePreview 加 header + 关闭按钮

**Files:**
- Rewrite: `src/web/views/FilePreview.tsx`
- Test: `src/web/views/FilePreview.test.tsx`

- [ ] **Step 1: 读取现有 FilePreview.test.tsx 确认结构**

Run: `read src/web/views/FilePreview.test.tsx`

确认现有测试用例，本次在其基础上**新增** header/关闭按钮用例，不删除现有的 markdown/媒体/代码用例。现有测试因 FilePreview 新增 `useFileSelection` 依赖，需要用 Provider 包裹——在 setup helper 中加。

- [ ] **Step 2: 改写 FilePreview.test.tsx 追加 header 测试**

在 `src/web/views/FilePreview.test.tsx` 顶部 import 追加：

```tsx
import { FileSelectionContext } from '../contexts/FileSelectionContext.js'
```

把现有 `withClient` helper 改造为同时包裹 FileSelectionContext（提供假 ctx），并在 `describe('FilePreview', ...)` 内**新增**两个用例：

```tsx
  it('渲染 header 显示路径', async () => {
    vi.stubGlobal('fetch', fetchMock('# Title'))
    withClient(<FilePreview path="readme.md" />)
    await waitFor(() => {
      expect(screen.getByTestId('preview-path').textContent).toBe('readme.md')
    })
  })

  it('点击关闭按钮调用 closeFile', async () => {
    const closeFile = vi.fn()
    vi.stubGlobal('fetch', fetchMock('# Title'))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <FileSelectionContext.Provider
          value={{ selectedFile: 'readme.md', openFile: () => {}, closeFile }}
        >
          <FilePreview path="readme.md" />
        </FileSelectionContext.Provider>
      </QueryClientProvider>,
    )
    await waitFor(() => {
      expect(screen.getByLabelText('关闭预览')).toBeTruthy()
    })
    fireEvent.click(screen.getByLabelText('关闭预览'))
    expect(closeFile).toHaveBeenCalledOnce()
  })
```

同时把现有 `withClient` helper 改为也包裹 FileSelectionContext（否则现有用例因 useFileSelection 抛错）：

```tsx
function withClient(ui: React.ReactNode, closeFile = () => {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <FileSelectionContext.Provider
        value={{ selectedFile: null, openFile: () => {}, closeFile }}
      >
        {ui}
      </FileSelectionContext.Provider>
    </QueryClientProvider>,
  )
}
```

确保 import 了 `fireEvent`（从 @testing-library/react）和 `vi`（从 vitest）。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run src/web/views/FilePreview.test.tsx`
Expected: FAIL — 现有用例因 `useFileSelection` 抛错；新用例找不到 `preview-path`/关闭按钮

- [ ] **Step 4: 重写 FilePreview.tsx**

把 `src/web/views/FilePreview.tsx` 整体替换为：

```tsx
import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { CodeBlock } from '../components/CodeBlock.js'
import { CodeEditor } from '../components/CodeEditor.js'
import { Markdown } from '../components/Markdown.js'
import { useFileSelection } from '../contexts/FileSelectionContext.js'
import { fileAPI } from '../services/file.js'

const wrap = css`
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  flex-shrink: 0;
`

const pathText = css`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
`

const closeBtn = css`
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
  flex-shrink: 0;

  &:hover {
    color: var(--text);
  }
`

const contentScroll = css`
  flex: 1;
  overflow: auto;
  min-height: 0;
`

const CODE_EXT = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'css',
  'html',
  'sh',
  'sql',
]
const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'flac']
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv']

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

export function FilePreview({ path }: { path: string }) {
  const { closeFile } = useFileSelection()
  const ext = extOf(path)
  const isMedia =
    IMG_EXT.includes(ext) || AUDIO_EXT.includes(ext) || VIDEO_EXT.includes(ext) || ext === 'pdf'

  const q = useQuery({
    queryKey: ['file', path],
    queryFn: () => fileAPI.read(path),
    enabled: !isMedia,
  })

  // 渲染内容区（不含 header）
  let body: React.ReactNode
  if (isMedia) {
    if (IMG_EXT.includes(ext)) {
      body = <img src={`/api/files/${encodeURI(path)}/raw`} alt={path} style={{ maxWidth: '100%' }} />
    } else if (ext === 'pdf') {
      body = (
        <embed
          src={`/api/files/${encodeURI(path)}/raw`}
          type="application/pdf"
          style={{ width: '100%', height: '100%' }}
          data-testid="pdf-preview"
        />
      )
    } else if (AUDIO_EXT.includes(ext)) {
      body = (
        <audio controls src={`/api/files/${encodeURI(path)}/raw`} style={{ width: '100%' }} data-testid="audio-preview">
          <track kind="captions" />
        </audio>
      )
    } else {
      body = (
        <video controls src={`/api/files/${encodeURI(path)}/raw`} style={{ maxWidth: '100%' }} data-testid="video-preview">
          <track kind="captions" />
        </video>
      )
    }
  } else if (q.isLoading) {
    body = <div style={{ padding: 12 }}>加载中…</div>
  } else if (!q.data) {
    body = <div style={{ padding: 12 }}>无内容</div>
  } else if (['md', 'markdown'].includes(ext)) {
    body = <Markdown content={q.data.content} />
  } else if (CODE_EXT.includes(ext)) {
    body = <CodeEditor path={path} initial={q.data.content} />
  } else {
    body = <CodeBlock code={q.data.content} lang={ext} />
  }

  return (
    <div className={wrap}>
      <header className={header}>
        <span className={pathText} data-testid="preview-path">
          {path}
        </span>
        <button type="button" className={closeBtn} onClick={closeFile} aria-label="关闭预览">
          ✕
        </button>
      </header>
      <div className={contentScroll}>{body}</div>
    </div>
  )
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run src/web/views/FilePreview.test.tsx`
Expected: PASS（原有用例 + 新增 header/关闭用例全过）

- [ ] **Step 6: Commit**

```bash
git add src/web/views/FilePreview.tsx src/web/views/FilePreview.test.tsx
git commit -m "feat(web): FilePreview 加 header + 关闭按钮"
```

---

## Task 5: Read/Edit/Write ToolView 路径可点击

**Files:**
- Modify: `src/web/components/session/tools/ReadToolView.tsx`
- Modify: `src/web/components/session/tools/EditToolView.tsx`
- Modify: `src/web/components/session/tools/WriteToolView.tsx`
- Test: `src/web/components/session/tools/read-write.test.tsx`（现有，追加用例）
- Test: `src/web/components/session/tools/EditToolView.test.tsx`（现有，追加用例）

- [ ] **Step 1: 读取现有测试文件**

Run: `read src/web/components/session/tools/read-write.test.tsx`
Run: `read src/web/components/session/tools/EditToolView.test.tsx`

确认现有结构。现有测试没有用 FileSelectionContext.Provider 包裹——加入 FilePathLink 后会抛错，需要给现有 render 调用加 Provider 包裹。

- [ ] **Step 2: 改写 read-write.test.tsx**

把 `src/web/components/session/tools/read-write.test.tsx` 整体替换为：

```tsx
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSelectionContext } from '../../../contexts/FileSelectionContext.js'
import { ReadToolView } from './ReadToolView.js'
import { WriteToolView } from './WriteToolView.js'

afterEach(cleanup)

// FilePathLink 依赖 FileSelectionContext，测试需包裹假 Provider
function withProvider(ui: React.ReactNode, openFile = vi.fn()) {
  render(
    <FileSelectionContext.Provider
      value={{ selectedFile: null, openFile, closeFile: () => {} }}
    >
      {ui}
    </FileSelectionContext.Provider>,
  )
  return openFile
}

describe('ReadToolView', () => {
  it('渲染文件名', () => {
    withProvider(<ReadToolView input={{ path: 'src/a.ts' }} status="completed" />)
    expect(screen.getByTestId('tool-title')).toHaveTextContent('read')
    expect(screen.getByTestId('file-name')).toHaveTextContent('src/a.ts')
  })

  it('error 状态显示错误信息', () => {
    withProvider(
      <ReadToolView
        input={{ path: 'a.ts' }}
        status="error"
        output={{ _tag: 'error', error: 'no file' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('no file')
  })

  it('路径为可点击 FilePathLink', () => {
    const openFile = withProvider(
      <ReadToolView input={{ path: 'src/a.ts' }} status="completed" />,
    )
    const link = screen.getByTestId('filepath-link')
    expect(link.textContent).toBe('src/a.ts')
    link.click()
    expect(openFile).toHaveBeenCalledWith('src/a.ts')
  })
})

describe('WriteToolView', () => {
  it('渲染文件名与写入提示', () => {
    withProvider(<WriteToolView input={{ path: 'b.ts', content: 'x' }} status="completed" />)
    expect(screen.getByTestId('file-name')).toHaveTextContent('b.ts')
  })

  it('error 状态显示错误信息', () => {
    withProvider(
      <WriteToolView
        input={{ path: 'b.ts', content: 'x' }}
        status="error"
        output={{ _tag: 'error', error: 'permission denied' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('permission denied')
  })

  it('路径为可点击 FilePathLink', () => {
    const openFile = withProvider(
      <WriteToolView input={{ path: 'b.ts', content: 'x' }} status="completed" />,
    )
    const link = screen.getByTestId('filepath-link')
    link.click()
    expect(openFile).toHaveBeenCalledWith('b.ts')
  })
})
```

- [ ] **Step 3: 改写 EditToolView.test.tsx**

读取现有文件后，同样用 `withProvider` 包裹现有 render 调用，并追加路径点击用例。在文件顶部 import 追加：

```tsx
import { FileSelectionContext } from '../../../contexts/FileSelectionContext.js'
```

加 helper（与 read-write.test.tsx 一致）：

```tsx
function withProvider(ui: React.ReactNode, openFile = vi.fn()) {
  render(
    <FileSelectionContext.Provider
      value={{ selectedFile: null, openFile, closeFile: () => {} }}
    >
      {ui}
    </FileSelectionContext.Provider>,
  )
  return openFile
}
```

把所有现有 `render(<EditToolView ... />)` 调用改为 `withProvider(<EditToolView ... />)`。追加用例：

```tsx
  it('路径为可点击 FilePathLink', () => {
    const openFile = withProvider(
      <EditToolView
        input={{ path: 'src/a.ts', oldText: 'x', newText: 'y' }}
        status="completed"
      />,
    )
    const link = screen.getByTestId('filepath-link')
    link.click()
    expect(openFile).toHaveBeenCalledWith('src/a.ts')
  })
```

- [ ] **Step 4: 运行测试确认失败**

Run: `pnpm vitest run src/web/components/session/tools/read-write.test.tsx src/web/components/session/tools/EditToolView.test.tsx`
Expected: FAIL — `filepath-link` testid 找不到（ToolView 仍渲染裸文本）

- [ ] **Step 5: 改 ReadToolView 使用 FilePathLink**

在 `src/web/components/session/tools/ReadToolView.tsx`：

顶部 import 追加：
```tsx
import { FilePathLink } from '../../FilePathLink.js'
```

把成功分支的文件名 div：
```tsx
      <div className={title} data-testid="file-name">
        {path}
      </div>
```
替换为：
```tsx
      <div className={title} data-testid="file-name">
        <FilePathLink path={path} />
      </div>
```

**错误分支的 `<span className={name}>read</span> · {path}` 不改**（文件可能不存在）。

- [ ] **Step 6: 改 WriteToolView 使用 FilePathLink**

在 `src/web/components/session/tools/WriteToolView.tsx`：

顶部 import 追加：
```tsx
import { FilePathLink } from '../../FilePathLink.js'
```

把成功分支的文件名 div：
```tsx
      <div className={title} data-testid="file-name">
        {path}
      </div>
```
替换为：
```tsx
      <div className={title} data-testid="file-name">
        <FilePathLink path={path} />
      </div>
```

- [ ] **Step 7: 改 EditToolView 使用 FilePathLink**

在 `src/web/components/session/tools/EditToolView.tsx`：

顶部 import 追加：
```tsx
import { FilePathLink } from '../../FilePathLink.js'
```

把成功分支的文件名 div：
```tsx
      <div className={title} data-testid="file-name">
        {path}
      </div>
```
替换为：
```tsx
      <div className={title} data-testid="file-name">
        <FilePathLink path={path} />
      </div>
```

- [ ] **Step 8: 运行测试确认通过**

Run: `pnpm vitest run src/web/components/session/tools/read-write.test.tsx src/web/components/session/tools/EditToolView.test.tsx`
Expected: PASS（全部用例）

- [ ] **Step 9: Commit**

```bash
git add src/web/components/session/tools/ReadToolView.tsx src/web/components/session/tools/WriteToolView.tsx src/web/components/session/tools/EditToolView.tsx src/web/components/session/tools/read-write.test.tsx src/web/components/session/tools/EditToolView.test.tsx
git commit -m "feat(web): read/write/edit 工具路径可点击打开预览"
```

---

## Task 6: ChatPage 接入 Provider + panel + SidebarTabs

**Files:**
- Modify: `src/web/App.tsx`

- [ ] **Step 1: 修改 ChatPage 函数**

在 `src/web/App.tsx`：

顶部 import 追加：
```tsx
import { useState } from 'react'
import { SidebarTabs, type SidebarTab } from './components/SidebarTabs.js'
import { FileBrowser } from './views/FileBrowser.js'
import { FilePreview } from './views/FilePreview.js'
import { FileSelectionContext, type FileSelection } from './contexts/FileSelectionContext.js'
```

把现有 `function ChatPage()` 整体替换为：

```tsx
function ChatPage() {
  const { projectId, sessionId } = useParams<{ projectId: string; sessionId: string }>()
  const navigate = useNavigate()
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(
    () => (localStorage.getItem('c0de-agent:sidebarTab') as SidebarTab) ?? 'sessions',
  )
  const switchTab = (t: SidebarTab) => {
    setSidebarTab(t)
    localStorage.setItem('c0de-agent:sidebarTab', t)
  }

  const fileCtx: FileSelection = {
    selectedFile,
    openFile: setSelectedFile,
    closeFile: () => setSelectedFile(null),
  }

  if (!projectId) {
    return <Layout header={<TopBar />} main={<NotFound />} />
  }

  return (
    <FileSelectionContext.Provider value={fileCtx}>
      <Layout
        header={<TopBar />}
        sidebar={
          <SidebarTabs
            activeTab={sidebarTab}
            onSwitch={switchTab}
            sessions={
              <SessionList
                projectId={projectId}
                activeId={sessionId ?? null}
                onSelect={(id) => navigate(`/projects/${projectId}/sessions/${id}`)}
                onProjectChange={(id) => navigate(`/projects/${id}`)}
                onNewSession={() => navigate(`/projects/${projectId}`)}
                onDeleted={(id) => {
                  // 删除的是当前会话则跳回草稿新会话页
                  if (id === (sessionId ?? null)) navigate(`/projects/${projectId}`)
                }}
              />
            }
            files={<FileBrowser onPick={setSelectedFile} />}
          />
        }
        main={<ChatView projectId={projectId} sessionId={sessionId ?? null} />}
        panel={selectedFile ? <FilePreview path={selectedFile} /> : null}
      />
    </FileSelectionContext.Provider>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm -w exec tsc --noEmit -p src/web/tsconfig.json`
Expected: 无类型错误

如果报 `useState` 已导入（App.tsx 可能已有 `useState` import），检查不重复导入。如果 App.tsx 顶部已有 `import { ... } from 'react'`，把 `useState` 加到那个 import 而非新开一行。

- [ ] **Step 3: 运行相关前端测试确认无回归**

Run: `pnpm vitest run src/web/components/session/tools/ src/web/views/FilePreview.test.tsx src/web/components/FilePathLink.test.tsx src/web/components/SidebarTabs.test.tsx src/web/contexts/FileSelectionContext.test.tsx`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add src/web/App.tsx
git commit -m "feat(web): ChatPage 接入文件浏览 panel + SidebarTabs + FileSelectionContext"
```

---

## Task 7: 全量验证

**Files:**
- Verify only

- [ ] **Step 1: 全量前端类型检查**

Run: `pnpm -w exec tsc --noEmit -p src/web/tsconfig.json`
Expected: 0 errors

- [ ] **Step 2: 全量前端测试**

Run: `pnpm vitest run src/web/`
Expected: 全部 PASS（无回归）

- [ ] **Step 3: Biome lint/format**

Run: `pnpm -w exec biome check src/web --write`
Expected: 无新错误（自动修复格式）

- [ ] **Step 4: 检查 FileBrowser 孤立状态消除**

Run: `pnpm -w exec grep -rn "FileBrowser" src/web/App.tsx`
Expected: 命中（App.tsx 已 import FileBrowser）

Run: `pnpm -w exec grep -rn "FilePreview" src/web/App.tsx`
Expected: 命中（App.tsx 已 import FilePreview）

- [ ] **Step 5: 如有 biome 自动修复产生的改动，提交**

```bash
git add -A
git commit -m "chore: biome format"  # 仅当有改动时
```

---

## 验收清单

实现完成后：

```bash
pnpm -w exec tsc --noEmit -p src/web/tsconfig.json
pnpm vitest run src/web/
```

功能验证（手动）：
1. 桌面端打开 ChatPage，sidebar 顶部有 💬会话 / 📁文件 两个 tab
2. 点 📁文件 tab → 显示 FileBrowser（搜索框 + 文件列表）
3. 点文件 → 右侧 360px panel 出现 FilePreview（含路径标题 + ✕ 关闭）
4. 点 ✕ → panel 消失
5. 对话流中 read/write/edit 工具的文件路径是彩色链接，点击后右侧 panel 打开预览
6. 刷新页面后 sidebar tab 保持上次选择（localStorage）
7. 切换会话/文件 tab 不丢失 panel 预览
