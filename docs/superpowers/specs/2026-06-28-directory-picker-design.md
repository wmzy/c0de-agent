# 目录选择器（DirectoryPicker）设计

> 日期：2026-06-28
> 范围：把「添加项目」的目录输入搜索从「单层子目录 + 前缀过滤」升级为 opencode `DialogSelectDirectoryV2` 等价的目录选择器——输入搜索（递归 + 模糊）+ 文件树浏览 + 快捷导航。

## 1. 背景与现状

当前「添加项目」对话框（`AddProjectDialog`）内嵌 `PathPicker`：

- 服务端 `GET /api/filesystem/browse?path=`：`readdir` 列出**单层级子目录**（任意路径，排除隐藏目录）。
- 客户端 `PathPicker`：取 `value` 最后一个 `/` 前作为父目录 → `browse` → `name.startsWith(filter)` **前缀过滤**。

局限：只能逐层浏览当前目录的直接子目录。输入纯名字（如 `c0de`）无法命中深层目录（如 `~/projects/c0de-agent`），必须手动逐层下钻。即用户所述「仅按文件层级提示」。

## 2. 目标

对齐 opencode web 的目录选择交互与搜索逻辑：

1. **输入搜索**：纯名字输入 → 服务端**递归搜索**目录树命中深层目录；路径输入 → **fuzzysort 分段模糊匹配**，可跨多级目录。
2. **文件树浏览**：可展开/折叠的文件树，展开时懒加载子目录，单击选择目录。
3. **快捷导航**：`~`（home）、根（`/`）、父目录按钮。
4. **键盘可达**：输入框 ↑/↓/Enter/Tab 操作建议；文件树可键盘选择。
5. 保留「添加项目」提交逻辑（`fromDirectory`）不变。

## 3. 参考实现（opencode）

- `packages/app/src/components/dialog-select-directory-v2.tsx`：对话框主体（Solid）。
- `packages/app/src/components/directory-picker-domain.ts`：纯函数 + `createDirectorySearch`。
- `packages/app/src/components/directory-picker-v2.css`：样式。
- 服务端：`file.list`（列目录）、`find.files({directory, query, type, limit})`（递归搜索）。

opencode 的 `createDirectorySearch` 搜索算法：

- 输入分类：拆为 `directory`（基目录）+ `query`（搜索词）。`~`/`~/x` → home；绝对路径 → 根；否则基于 base。
- **纯名字输入**（无 `/`、无 `~`、非绝对路径）→ 服务端递归搜索（`find.files`），limit 50。
- **路径输入** → `query` 按 `/` 分段，逐段 fuzzysort 模糊匹配（每段命中后展开候选路径，支持 `..`，竞态取消，目录列表缓存）。
- 选中目录建议 → `navigate(dir)` 加载该目录到文件树。

opencode 用 `@pierre/trees`（虚拟化 FileTree web component）+ `@opencode-ai/ui/v2/*`。c0de-agent 无这些依赖，需在 React 中实现等价物（见 §7 适配决策）。

## 4. 架构与组件分解

```
AddProjectDialog（overlay/dialog 外壳，提交 fromDirectory）
└── DirectoryPicker（核心选择器，替代 PathPicker）
    ├── 路径输入框（combobox）+ 操作按钮（~/根/父）
    ├── 建议下拉（递归搜索 + fuzzysort）
    ├── FileTree（递归文件树，懒加载展开 + 选择）
    └── 选择显示栏
```

### 新建组件

#### `src/web/components/DirectoryPicker.tsx`

核心受控组件。

```ts
type DirectoryPickerProps = {
  value: string                 // 当前输入路径（受控）
  onChange: (v: string) => void // 输入变更 + 选中目录同步（确认按钮据此提交）
  mode?: 'directory'            // 固定 directory（file 模式留作扩展）
  start?: string                // 初始根目录（默认 home）
  placeholder?: string
  testId?: string
  autoFocus?: boolean
}
```

职责：
- 内部状态：`root`（当前文件树根）、`selected`（选中目录）、`suggestions`（建议列表）、`loading/error`。
- 输入框值 = 受控 `value`；输入 → `createDirectorySearch` → 建议下拉。
- 选中目录建议 / 操作按钮 → `navigate(dir)` → `browse` 加载子目录填充 FileTree。
- FileTree 展开 → 懒加载子目录；选择目录 → `onChange(selectedPath)` 同步父级（提交按钮据此）。
- home/root/parent 按钮调用 `pickerRoot`/`pickerParent` 后 `navigate`。
- 契约保持与旧 `PathPicker` 一致（value/onChange/onKeyDown/placeholder/testId/autoFocus），`AddProjectDialog` 仅替换标签名。

#### `src/web/components/FileTree.tsx`

递归文件树，复用 `BranchTree.tsx` 的递归渲染模式（`TreeNode` 自递归 + 缩进）。

```ts
type FileTreeProps = {
  entries: TreeEntry[]          // 当前已加载的目录条目（name + path + loaded 子节点）
  expanded: Set<string>
  selected: string | null
  onToggle: (path: string) => void  // 展开/折叠（触发懒加载）
  onSelect: (path: string) => void
  loadingPaths: Set<string>     // 正在加载子目录的节点
}
type TreeEntry = { name: string; path: string; type: 'directory' }
```

- 非虚拟化递归渲染（添加项目场景目录浅，性能足够；避免引入虚拟化库）。
- 目录节点：`▶`/`▼` 展开标记 + 名称；展开时 `onToggle` → 父组件 `browse` 加载子目录。
- 单击目录名 → `onSelect`。

#### `src/web/components/directory-picker-domain.ts`

移植 opencode 纯函数（框架无关，直接搬移并适配为 TS），使搜索逻辑可独立单测：

- 输入清洗：`cleanPickerInput`
- 路径规范化：`normalizePickerPath`、`normalizePickerDrive`、`trimPickerPath`、`joinPickerPath`
- 路径分析：`pickerRoot`、`pickerParent`、`canonicalPickerPath`
- 显示：`displayPickerPath`
- 建议索引：`currentPickerSuggestions`、`nextSuggestionIndex`
- `createDirectorySearch(args)`：核心搜索。`args` 注入 c0de-agent 的 service 访问器（`listDir(path)`、`searchDir(directory, query, limit)`、`home()`、`base()`），返回 `async (filter: string) => string[]`。内部 fuzzysort 分段匹配 + 目录列表 `Map` 缓存 + `current` 自增竞态取消。

### 改造组件

#### `src/web/components/AddProjectDialog.tsx`

- 用 `DirectoryPicker` 替换 `PathPicker`（props 契约一致，仅换标签名 + onKeyDown 不变）。
- 提交逻辑（`fromDirectory` + invalidate queries）不变；确认按钮仍用 `directory` state（由 DirectoryPicker.onChange 同步）。
- 文案 hint 更新。

## 5. 服务端契约

### 新增端点：`GET /api/filesystem/search`

递归搜索目录（任意起点），对应 opencode `find.files`。

```
GET /api/filesystem/search?directory=<abs>&q=<query>&limit=<n>
→ { items: string[] }   // 相对 directory 的目录路径（type=directory）
```

实现（`src/server/routes/filesystem.ts`）：

- 新增 `searchDirectories(directory, query, limit)`：基于 `files.ts` 的 `collectFiles` 思路，但：
  - 起点为请求的 `directory`（任意绝对路径，经 `expandPath` 展开 `~`），不锁在 cwd。
  - 只收集 `type === 'directory'`。
  - 跳过 `.git`、`node_modules`、隐藏目录（`.` 开头）。
  - 限深（默认 5 层）+ `limit`（默认 50）。
  - 匹配：`path.toLowerCase().includes(query.toLowerCase())`（服务端粗筛；客户端 fuzzysort 精排）。
- 复用现有 `expandPath`。

### 保留端点

- `GET /api/filesystem/browse?path=`：单层子目录（FileTree 懒加载 + pathInput 分段匹配用）。
- `GET /api/filesystem/home`：home 路径。

## 6. 客户端 service 层

`src/web/services/filesystem.ts` 新增：

```ts
type SearchResponse = { items: string[] }
const filesystemAPI = {
  browse,            // 已有
  home,              // 已有
  search: (directory: string, q: string, limit = 50) =>
    apiRequest<SearchResponse>(
      `/api/filesystem/search?directory=${encodeURIComponent(directory)}&q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
}
```

## 7. 关键适配决策

| 决策 | 选择 | 理由 |
|---|---|---|
| FileTree 虚拟化 | **否**，递归渲染 + 懒加载 | c0de-agent 无虚拟化库；添加项目目录浅；避免新依赖。复用 BranchTree 模式。 |
| 模糊匹配库 | **fuzzysort**（新增依赖） | 与 opencode 同库，轻量（~10KB），分段匹配质量好。 |
| domain 函数 | **移植** opencode 的纯函数 | 框架无关、覆盖边界（`~`、Windows 盘符、`//` UNC、`..`、竞态），已验证。 |
| 对话框外壳 | **复用** AddProjectDialog 现有 overlay/dialog 样式 | 保持 c0de-agent linaria 风格一致。 |
| file 模式 | **不实现**（仅 directory） | 当前需求是「添加项目」选目录；domain 保留 `mode` 入参以便扩展但 UI 只走 directory。 |

## 8. 数据流

```
用户输入 → createDirectorySearch(filter)
  ├─ 纯名字 → filesystemAPI.search(directory, q) → 递归命中深层目录
  └─ 路径   → browse(各段目录, 缓存) → fuzzysort 分段匹配 → 候选路径
  → 建议下拉（目录/）
选中目录建议 → navigate(dir)
  → browse(dir) 加载子目录 → FileTree 渲染
FileTree 展开 → onToggle → browse(子目录) 懒加载
FileTree 选择 → onSelect → selected → 选择栏 + 确认按钮可用
确认 → AddProjectDialog.fromDirectory(selected||value)
```

## 9. 文件清单

### 新建
- `src/web/components/DirectoryPicker.tsx`
- `src/web/components/FileTree.tsx`
- `src/web/components/directory-picker-domain.ts`
- `src/web/components/directory-picker-domain.test.ts`
- `src/web/components/DirectoryPicker.test.tsx`
- `src/web/components/FileTree.test.tsx`

### 修改
- `src/server/routes/filesystem.ts`：新增 `/search` 端点 + `searchDirectories`
- `src/server/routes/filesystem.test.ts`：新增 `/search` 用例
- `src/web/services/filesystem.ts`：新增 `search`
- `src/web/components/AddProjectDialog.tsx`：用 DirectoryPicker 替换 PathPicker
- `src/web/components/AddProjectDialog.test.tsx`：适配新结构
- `package.json`：新增 `fuzzysort` 依赖

### 删除
- `src/web/components/PathPicker.tsx` + `PathPicker.test.tsx`（被 DirectoryPicker 取代，无其他调用方）

## 10. 测试策略

**服务端 `filesystem.test.ts`**（追加到现有 describe）：
- `/search` 递归命中深层目录
- `/search` 仅返回 directory、跳过 .git/node_modules/隐藏目录
- `/search` limit 截断
- `/search` 空查询返回顶层目录

**`directory-picker-domain.test.ts`**（纯函数，边界优先）：
- `cleanPickerInput`：多行/控制字符/trim
- `pickerRoot`/`pickerParent`：`/`、`~`、Windows 盘符、`//` UNC、`..`
- `canonicalPickerPath`：`.` / `..` 归约
- `createDirectorySearch`：纯名字走 searchDir；路径走分段匹配；竞态（后发先至丢弃）；目录列表缓存命中

**`FileTree.test.tsx`**：
- 递归渲染目录节点
- 展开/折叠触发 onToggle
- 选择触发 onSelect

**`DirectoryPicker.test.tsx`**：
- 输入纯名字 → 建议下拉显示递归命中
- 选中目录建议 → 导航（root 变更 + FileTree 加载）
- home/parent 按钮 → 导航
- 选中目录 → 选择栏更新 + onChange(path) 回调
- 加载失败 → 错误态

**`AddProjectDialog.test.tsx`**（适配）：
- 选中目录 + 确认 → fromDirectory 调用
- fromDirectory 失败 → 错误提示

## 11. 非目标

- file 模式选择器（仅 directory）。
- 多选目录。
- 文件树虚拟化（大目录性能优化）。
- 服务端 ripgrep 加速（用 node readdir 递归，限深 + limit 已足够）。
- 国际化（沿用 c0de-agent 中文文案）。
