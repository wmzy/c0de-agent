# 文件浏览/预览/编辑集成到主界面

> 日期：2026-07-01
> 状态：待实现
> 关联：`2026-06-27-web-frontend-react` Task 9（组件已创建但未接入）、`modules/web-ui.md` §2.6（文件浏览器设计）

## 1. 问题

`2026-06-27-web-frontend-react.md` 的 Task 9 创建了 `FileBrowser.tsx`、`FilePreview.tsx`、`CodeEditor.tsx` 三个组件，后端 `files.ts`（GET list/read、PUT write、search）路由也完整。但这些组件**从未挂载到任何页面**——`App.tsx` 的 ChatPage 只用了 sidebar(SessionList) + main(ChatView)，没有 panel，没有文件浏览入口。

证据：
- `FileBrowser.tsx`：零引用（除自身）。
- `FilePreview.tsx`：仅被自身测试引用。
- `CodeEditor.tsx`：仅被孤立的 FilePreview 引用。
- `App.tsx:133` ChatPage 的 `<Layout>` 调用无 `panel` prop。

而 spec（`web-ui.md §2.6`、`c0de-agent-design.md §985-994`）明确要求 Chat 页面「左侧含文件浏览器」「点击文件在右侧预览面板打开」。

唯一接入的是 `CodeReference.tsx`（被 AssistantTextBlock 引用），但那是消息内代码引用，不是文件浏览功能。

## 2. 目标

| # | 目标 | 验收 |
|---|------|------|
| G1 | sidebar 支持会话/文件 Tab 切换，文件 Tab 渲染 FileBrowser | 文件 Tab 选中时 sidebar 显示 `file-search` 输入框 |
| G2 | 点 FileBrowser 中的文件，右侧 panel（360px，桌面端）渲染 FilePreview | 选中文件后 panel 出现，显示文件内容 |
| G3 | FilePreview 顶部有路径标题 + 关闭按钮，关闭后清空 panel | 点关闭后 panel 消失 |
| G4 | 对话流中 read/write/edit 工具的文件路径可点击，点击打开右侧预览 | 点 tool 路径后 panel 显示该文件 |
| G5 | sidebar Tab 选择持久化到 localStorage（与会话/模型选择一致） | 刷新后 Tab 保持 |
| G6 | 移动端行为不回归（panel 仅桌面端显示，Layout 已处理） | 移动端视口下无布局错位 |

## 3. 非目标（YAGNI）

- **不新建独立 `/files` 路由页**：在 ChatPage 内集成即可。
- **不改后端**：`files.ts` 路由、`fileAPI` service 均已完整。
- **不做 glob/grep/bash 工具路径点击**：这些工具的 input 无单个文件路径（glob 是 pattern，grep 是 pattern+path，bash 是命令），不在本次范围。
- **不做文件树懒加载重构**：现有 FileBrowser 是平铺列表 + 搜索，非递归树。DirectoryPicker（带 FileTree）是另一个独立功能（项目目录选择），不复用进来——那是 picker 语义，非 browse 语义。
- **不碰代码引用跳转**（`@[path:line]` 点击跳文件浏览器）：CodeReference 当前只在消息内显示，跨组件跳转是独立增强。
- **不改 Layout**：Layout 已有 `panel` 槽（`Layout.tsx:64-69`，360px 桌面端），无需改动。

## 4. 数据流

```
ChatPage (持 selectedFile 状态 + sidebarTab 状态)
├── <FileSelectionContext.Provider value={{ openFile, closeFile, selectedFile }}>
│   ├── sidebar:
│   │   └── <SidebarTabs>
│   │       ├── tab="会话" → SessionList (现有, 不动)
│   │       └── tab="文件" → FileBrowser onPick={openFile}  (现有孤立组件, 接入)
│   ├── main: ChatView (现有, 不动)
│   │   └── ... → TimelineChat → MessageItem → ToolBlock → Read/Edit/Write ToolView
│   │                                                                   └── FilePathLink (新)
│   │                                                                        └── onClick → openFile
│   └── panel: selectedFile ? <FilePreview path={selectedFile} /> : null
```

- `selectedFile`：ChatPage 持有的 `string | null`，唯一真相源。
- `openFile(path)`：context 下发，`setSelectedFile(path)` + 可选切到文件 Tab 旁侧。
- `closeFile()`：`setSelectedFile(null)`。
- `sidebarTab`：`'sessions' | 'files'`，localStorage `c0de-agent:sidebarTab` 持久化。

## 5. 详细设计

### 5.1 FileSelectionContext（新，`src/web/contexts/FileSelectionContext.tsx`）

最小 context，仅传三个值。不需要 useReducer——两个 state 够用。

```tsx
type FileSelection = {
  selectedFile: string | null
  openFile: (path: string) => void
  closeFile: () => void
}
const FileSelectionContext = createContext<FileSelection | null>(null)

function useFileSelection(): FileSelection {
  const ctx = useContext(FileSelectionContext)
  if (!ctx) throw new Error('useFileSelection must be used within FileSelectionContext')
  return ctx
}
```

Provider 不在此文件——state 由 ChatPage 持有（因为 panel 消费 selectedFile）。此文件只导出 Context、hook、类型。

### 5.2 ChatPage 改造（`src/web/App.tsx`）

ChatPage 持有 `selectedFile` 和 `sidebarTab` 状态，包裹 Provider，渲染 sidebar/panel：

```tsx
function ChatPage() {
  const { projectId, sessionId } = useParams()
  const navigate = useNavigate()
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [sidebarTab, setSidebarTab] = useState<'sessions' | 'files'>(
    () => (localStorage.getItem('c0de-agent:sidebarTab') as 'sessions' | 'files') ?? 'sessions',
  )
  const switchTab = (t: 'sessions' | 'files') => {
    setSidebarTab(t)
    localStorage.setItem('c0de-agent:sidebarTab', t)
  }

  const ctx: FileSelection = {
    selectedFile,
    openFile: setSelectedFile,
    closeFile: () => setSelectedFile(null),
  }

  return (
    <FileSelectionContext.Provider value={ctx}>
      <Layout
        header={<TopBar />}
        sidebar={
          <SidebarTabs
            activeTab={sidebarTab}
            onSwitch={switchTab}
            sessions={<SessionList ... />}      // 现有 props 不变
            files={<FileBrowser onPick={setSelectedFile} />}
          />
        }
        main={<ChatView ... />}
        panel={selectedFile ? <FilePreview path={selectedFile} /> : null}
      />
    </FileSelectionContext.Provider>
  )
}
```

注：草稿页（`DraftChatPage` 或 ChatView 内嵌的草稿态）也需要 Provider，否则草稿消息中的工具路径点击会报错。两个 ChatPage 变体都用同一 wrapper。

### 5.3 SidebarTabs（新，`src/web/components/SidebarTabs.tsx`）

纯切换器，不持有状态：

```tsx
type SidebarTabsProps = {
  activeTab: 'sessions' | 'files'
  onSwitch: (t: 'sessions' | 'files') => void
  sessions: ReactNode
  files: ReactNode
}
```

顶部两个 tab 按钮（💬会话 / 📁文件），下方渲染对应 children。样式复用现有 tab 风格（参考 `LLMDetail.tsx` 中 tab 切换如有，或走 `themeVars` 边框）。

### 5.4 FilePreview 改造（`src/web/views/FilePreview.tsx`）

加 header：路径标题 + ✕ 关闭按钮。关闭按钮调 `useFileSelection().closeFile()`。

```tsx
const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  flex-shrink: 0;
`

// 在现有 wrap 内，所有内容之前加：
<header className={header}>
  <span data-testid="preview-path">{path}</span>
  <button onClick={closeFile} type="button" aria-label="关闭预览">✕</button>
</header>
```

现有内容区需包在一个 `flex: 1; overflow: auto` 的容器里，与 header 并列。

### 5.5 FilePathLink（新，`src/web/components/FilePathLink.tsx`）

可点击文件路径，点击调 `useFileSelection().openFile(path)`。视觉上像链接：primary 色、hover 下划线、cursor pointer。

```tsx
export function FilePathLink({ path }: { path: string }) {
  const { openFile } = useFileSelection()
  return (
    <button
      type="button"
      className={link}
      onClick={() => openFile(path)}
      title={`预览 ${path}`}
    >
      {path}
    </button>
  )
}
```

### 5.6 ToolView 改造（Read/Edit/Write）

三个 ToolView 的 `data-testid="file-name"` 元素，把裸 `{path}` 替换为 `<FilePathLink path={path} />`。其余渲染（FileCodeBlock、ContentDiff）不变。

ReadToolView（`tools/ReadToolView.tsx`）、EditToolView（`tools/EditToolView.tsx`）、WriteToolView（`tools/WriteToolView.tsx`）各改一处。

错误分支中的 path 显示（`<span className={name}>read</span> · {path}`）不改——错误时文件可能不存在，点击预览无意义。

## 6. 文件清单

| 文件 | 改动 | 说明 |
|------|------|------|
| `src/web/contexts/FileSelectionContext.tsx` | 新建 | Context + hook + 类型 |
| `src/web/components/SidebarTabs.tsx` | 新建 | tab 切换器 |
| `src/web/components/FilePathLink.tsx` | 新建 | 可点击路径链接 |
| `src/web/App.tsx` | 修改 | ChatPage 接入 Provider + Layout panel + SidebarTabs |
| `src/web/views/FilePreview.tsx` | 修改 | 加 header + 关闭按钮 |
| `src/web/components/session/tools/ReadToolView.tsx` | 修改 | path → FilePathLink |
| `src/web/components/session/tools/EditToolView.tsx` | 修改 | path → FilePathLink |
| `src/web/components/session/tools/WriteToolView.tsx` | 修改 | path → FilePathLink |

**不改**：Layout.tsx、FileBrowser.tsx、CodeEditor.tsx、SessionList.tsx、后端任何文件、fileAPI service。

## 7. 测试

| 组件 | 测试文件 | 关键用例 |
|------|---------|---------|
| SidebarTabs | `SidebarTabs.test.tsx`（新） | 渲染两 tab，点击切换，渲染对应 children |
| FilePathLink | `FilePathLink.test.tsx`（新） | 点击调 openFile，渲染 path 文本 |
| FilePreview | `FilePreview.test.tsx`（改） | 新增：渲染 header + path，点关闭调 closeFile |
| ReadToolView | `ReadToolView.test.tsx`（改/查） | path 处渲染 FilePathLink，点击可触发（需 Provider 包裹） |
| ChatPage | 手动 / E2E | 文件 Tab → 选文件 → panel 预览 → 关闭；工具路径点击 |

ToolView 测试因依赖 context，用 helper 包裹 `<FileSelectionContext.Provider>` 提供假 ctx。

## 8. 风险

- **草稿页 Provider 缺失**：草稿态（无 sessionId）的 ChatView 也渲染 ToolBlock，若未包 Provider，FilePathLink 点击报错。缓解：两个 ChatPage 变体共用同一 wrapper 函数，确保 Provider 总在。
- **移动端 panel 不可见**：Layout panel 仅桌面端（`min-width:1024px`）。移动端点文件后预览看不到——但这是现有 Layout 行为，非本次引入。本次不修移动端，记为已知限制。
- **大文件预览**：FilePreview 调 `fileAPI.read` 拉全量内容。超大文件可能卡顿，但这是现有行为（FilePreview 已实现），本次不改。
