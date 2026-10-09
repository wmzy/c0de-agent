import { css } from '@linaria/core'
import type { KeyboardEvent } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitStatusCode } from '@/types/index.js'

/** 文件树节点。children 为 undefined 表示尚未加载子目录。type 缺省视为 directory（兼容目录选择器）。 */
export type TreeNode = {
  name: string
  path: string
  type?: 'file' | 'directory'
  children?: TreeNode[]
  ignored?: boolean
}

type FileTreeProps = {
  /** 根节点。null 时不渲染。 */
  root: TreeNode | null
  /** 已展开的目录路径集合。 */
  expanded: Set<string>
  /** 当前选中节点路径。 */
  selected: string | null
  /** 正在加载子目录的节点路径集合。 */
  loadingPaths: Set<string>
  /** 展开/折叠目录（首次展开由父组件触发懒加载）。 */
  onToggle: (path: string) => void
  /** 激活节点：文件=打开；目录行为由 directoryClickMode 决定。 */
  onSelect: (path: string) => void
  /** 点击目录名的行为：select=选中（目录选择器），toggle=展开/折叠（文件浏览器）。默认 select。 */
  directoryClickMode?: 'select' | 'toggle'
  /** 引用文件到输入框（文件树 @ 按钮）；仅文件节点，提供时显示按钮。 */
  onMention?: (path: string) => void
  /** 删除节点（移入系统回收站）；提供时显示 🗑 按钮。 */
  onDelete?: (path: string) => void
  /** git 状态映射（path → 分类），用于高亮未提交/stage/未跟踪文件与目录。 */
  gitStatusMap?: Record<string, GitStatusCode>
  /** 无障碍标签：role=tree 容器的 aria-label，供读屏播报树用途。 */
  label?: string
  /** 隐藏根节点本身，直接渲染其子项（文件浏览器：顶部已有项目名指示器，根节点冗余）。 */
  hideRoot?: boolean
}

const tree = css`
  font-size: 12.5px;
  user-select: none;
`

const row = css`
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 36px;
  padding: 2px 8px;
  cursor: pointer;
  border-radius: 4px;
  &:hover {
    background: var(--haze-color-bg-subtle);
  }
  /* hover 时增强 @/删除 按钮（常驻低对比度，hover 提升到全亮） */
  &:hover [data-mention-btn] {
    opacity: 1;
  }
  &:hover [data-delete-btn] {
    opacity: 1;
  }
`

const selectedRow = css`
  background: var(--haze-color-bg-subtle);
  font-weight: 600;
`

/**
 * 折叠/展开位的共享骨架：目录行是按钮，文件行是 aria-hidden 的占位。
 *
 * 两者必须等宽——目录行多一个展开按钮、文件行没有，宽度不等就会让每层
 * 缩进的文件名左右错开（实测修复前两者各写一条规则、各写一个 16px，
 * 任何一次只改其一的提交都会造成错位）。放进同一条规则后宽度只有一处事实源。
 *
 * 宽度 24px 而非原来的 16px：16px 宽的行内控件是侧栏里最难命中的尺寸，
 * 侧栏 280px / 行高 36px，每个目录都要瞄一条 16px 竖缝。WCAG 2.5.8
 * （Target Size Minimum，AA）下限是 24×24 CSS px，16px 连下限都不到。
 * 24px 仍是紧凑行高，目录树密度不变。
 *
 * min-height: 32px 覆盖全局按钮的 44px 最小高度：行高只有 36px，让位给
 * 44px 会把每行撑成两倍高。宽度同理不走 44px——侧栏放不下，且名字本身
 * 已经是可点的大热区，展开按钮只需够得着。
 */
const toggleBase = css`
  width: 24px;
  flex-shrink: 0;
  text-align: center;
  background: transparent;
  border: none;
  color: var(--haze-color-text-secondary);
  cursor: pointer;
  padding: 0;
  font-size: 10px;
  min-height: 32px;
  min-width: auto;
`

/** 文件行的折叠位：只占位，不接受点击。 */
const toggle = toggleBase

/** 目录行的展开/折叠按钮。 */
const toggleBtn = toggleBase

const rowBtn = css`
  flex: 1;
  padding: 0;
  /* 覆盖全局按钮 44px 最小尺寸：与 36px 行高匹配 */
  min-height: 32px;
  min-width: auto;
`

const childList = css`
  padding-left: 10px;
  border-left: 1px solid var(--haze-color-border);
  margin-left: 6px;
`

const hint = css`
  padding: 3px 8px 3px 24px;
  color: var(--haze-color-text-secondary);
  font-size: 12px;
`

const mentionBtn = css`
  margin-left: auto;
  /* 常驻低对比度（非 hover 也可发现/触屏可达），hover 增强到全亮 */
  opacity: 0.65;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--haze-color-text-secondary);
  cursor: pointer;
  font-size: 11px;
  padding: 0;
  min-height: 32px;
  min-width: 32px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.1s, color 0.1s;
  &:hover {
    color: var(--haze-color-primary);
  }
`

const deleteBtn = css`
  opacity: 0.65;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--haze-color-text-secondary);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
  min-height: 32px;
  min-width: 32px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.1s, color 0.1s;
  &:hover {
    color: var(--haze-color-danger);
  }
`

/* git 状态高亮：文件名颜色 + 左缘色条。 */
const gitModified = css`
  color: var(--haze-color-warning);
  box-shadow: inset 2px 0 0 var(--haze-color-warning);
`
const gitStaged = css`
  color: var(--haze-color-success);
  box-shadow: inset 2px 0 0 var(--haze-color-success);
`
const gitUntracked = css`
  color: var(--haze-color-primary);
  box-shadow: inset 2px 0 0 var(--haze-color-primary);
`
const gitConflict = css`
  color: var(--haze-color-danger);
  box-shadow: inset 2px 0 0 var(--haze-color-danger);
`
const gitDeleted = css`
  color: var(--haze-color-text-secondary);
  box-shadow: inset 2px 0 0 var(--haze-color-text-secondary);
  text-decoration: line-through;
`
// .gitignore 里的文件仍要能看清文件名——此前用 opacity:0.55 把整行（含文字）
// 一起调暗，浅色主题实测降到 3.76:1（12.5px 正文要求 4.5:1，axe 报 serious
// 级 color-contrast，用户在文件树里几乎读不出 .c0de/.env 这类条目）。
// 改为「换颜色而非降透明度」：透明度会把文字一起压暗、且与背景叠加后无法
// 保证对比度；这里只调文字色到 --haze-color-text-secondary 的实色值，
// 浅色/深色两套主题各自的 token 都已满足 4.5:1。
const gitIgnored = css`
  color: var(--haze-color-text-secondary);
`

/** git 状态 → 高亮类名。 */
function gitClass(code: GitStatusCode): string {
  switch (code) {
    case 'modified':
      return gitModified
    case 'staged':
      return gitStaged
    case 'untracked':
      return gitUntracked
    case 'conflict':
      return gitConflict
    case 'deleted':
      return gitDeleted
    case 'ignored':
      return gitIgnored
  }
}

/** 目录聚合：取后代中优先级最高的状态。 */
const GIT_PRIORITY: Record<GitStatusCode, number> = {
  conflict: 5,
  untracked: 4,
  modified: 3,
  staged: 2,
  deleted: 1,
  ignored: 0,
}

/** 计算 path 的显示 git 状态：文件直接查表；目录取后代最高优先级。 */
function resolveGitStatus(
  path: string,
  isFile: boolean,
  map: Record<string, GitStatusCode> | undefined,
): GitStatusCode | undefined {
  if (!map) return undefined
  if (isFile) return map[path]
  // 目录：查所有以 `${path}/` 为前缀的状态，取最高优先级
  const prefix = path === '.' ? '' : `${path}/`
  let best: GitStatusCode | undefined
  let bestPrio = -1
  for (const [p, code] of Object.entries(map)) {
    if (prefix === '' ? true : p.startsWith(prefix)) {
      if (GIT_PRIORITY[code] > bestPrio) {
        best = code
        bestPrio = GIT_PRIORITY[code]
      }
    }
  }
  return best
}

/**
 * 递归文件树：目录可展开（懒加载），文件为叶子节点。
 * directoryClickMode='select' 时点目录名=选中（目录选择器用法）；
 * 'toggle' 时点目录名=展开/折叠（文件浏览器用法）。
 */
export function FileTree(props: FileTreeProps) {
  // root 为 null 时整棵树不渲染。必须在任何 hook 之前返回——下面的
  // useMemo/useEffect 无条件依赖 root 的非空版本。
  if (!props.root) return null
  return <FileTreeInner {...props} root={props.root} />
}

/** FileTree 的实现体；root 在此已保证非空。 */
function FileTreeInner({
  root,
  expanded,
  selected,
  loadingPaths,
  onToggle,
  onSelect,
  directoryClickMode = 'select',
  onMention,
  onDelete,
  gitStatusMap,
  label = '文件树',
  hideRoot,
}: FileTreeProps & { root: TreeNode }) {
  const treeRef = useRef<HTMLDivElement>(null)
  // 漫游 tabindex：整棵树只让一个节点可 Tab 进入，其余 tabindex=-1，由方向键在
  // 节点间移动（ARIA tree 的标准键盘模型）。
  //
  // 此前所有 treeitem 一律 tabIndex={-1} 且没有任何方向键处理：容器声明了
  // role="tree"（读屏会按可交互树播报），实际上键盘完全进不去——Tab 只会
  // 逐个经过行内的展开/@/删除按钮，跳过文件名本身，↑↓ 无响应。
  //
  // 初始焦点优先给已选中的节点（用户刚操作完的文件就是最可能的下一步目标），
  // 否则第一个可见节点。
  const [focusedPath, setFocusedPath] = useState<string | null>(null)

  // 当前渲染出的全部节点（DOM 顺序 = 视觉顺序 = 缩进顺序）。
  // 方向键在「可见节点」上移动：折叠起来的子节点不在 DOM 里，自然被跳过。
  const visiblePaths = useMemo(
    () => collectVisiblePaths(root, expanded, hideRoot === true),
    [root, expanded, hideRoot],
  )

  // focusedPath 指向的节点被折叠/删除后，顺延到它原来的位置而不是回退到树首。
  //
  // 归一化放在渲染期而不是 effect：懒加载展开目录会让 root 换成新对象引用
  // （FileBrowser 的 setChildren 不可变重建），若用 effect 归一化，它会在
  // 每次这类重建后把刚移动的焦点弹回旧位置——实测 ↑↓↓ 到 src/cli 后立刻
  // 又回到 src。渲染期归一是纯派生值，不产生额外一轮提交，也就没有回弹。
  const effectiveFocusedPath =
    visiblePaths.length === 0
      ? null
      : focusedPath && visiblePaths.includes(focusedPath)
        ? focusedPath
        : ((selected && visiblePaths.includes(selected) ? selected : visiblePaths[0]) ?? null)

  // focusedPath 变化时把真实焦点移到对应节点。键盘用户 Tab 进入树后，
  // 焦点必须跟着漫游标记走，否则按方向键只改状态不改焦点，读屏不播报。
  //
  // 但只在焦点本来就在树里时才搬：漫游标记每次变化都无条件 focus()，会把
  // 焦点从别处抢进树——实测「添加项目」弹窗打开后，home 目录异步加载完成、
  // 漫游标记从 null 落到第一行的瞬间，焦点从路径输入框被拽到文件树第一行，
  // 用户敲到一半的字符全丢。树外要进树，Tab 落在唯一 tabIndex=0 的节点上
  // 即可，本来就不需要这个 effect 代劳。
  useEffect(() => {
    if (!effectiveFocusedPath) return
    const tree = treeRef.current
    if (!tree?.contains(document.activeElement)) return
    const el = tree.querySelector<HTMLElement>(
      `[role="treeitem"][data-path="${cssEscape(effectiveFocusedPath)}"]`,
    )
    if (el && el.getAttribute('data-focused') === 'true') el.focus()
  }, [effectiveFocusedPath])

  const moveFocus = useCallback(
    (delta: number) => {
      if (visiblePaths.length === 0) return
      const idx = effectiveFocusedPath ? visiblePaths.indexOf(effectiveFocusedPath) : -1
      const next = idx === -1 ? (delta > 0 ? 0 : visiblePaths.length - 1) : idx + delta
      const target = visiblePaths[Math.max(0, Math.min(visiblePaths.length - 1, next))]
      if (target) setFocusedPath(target)
    },
    [visiblePaths, effectiveFocusedPath],
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          moveFocus(1)
          break
        case 'ArrowUp':
          e.preventDefault()
          moveFocus(-1)
          break
        case 'Home':
          e.preventDefault()
          setFocusedPath(visiblePaths[0] ?? null)
          break
        case 'End':
          e.preventDefault()
          setFocusedPath(visiblePaths[visiblePaths.length - 1] ?? null)
          break
        case 'ArrowRight': {
          // 目录：折叠时展开，已展开时进入第一个子节点；文件：不动。
          if (!effectiveFocusedPath) return
          const node = findNode(root, effectiveFocusedPath)
          if (!node || node.type === 'file') return
          e.preventDefault()
          if (!expanded.has(effectiveFocusedPath)) {
            onToggle(effectiveFocusedPath)
          } else {
            const firstChild = node.children?.[0]?.path
            if (firstChild) setFocusedPath(firstChild)
          }
          break
        }
        case 'ArrowLeft': {
          if (!effectiveFocusedPath) return
          const node = findNode(root, effectiveFocusedPath)
          if (!node) return
          e.preventDefault()
          // 目录自身已展开：先折叠；未展开或有子节点可见：跳到父节点。
          if (node.type !== 'file' && expanded.has(effectiveFocusedPath)) {
            onToggle(effectiveFocusedPath)
            return
          }
          const parentPath = parentOf(effectiveFocusedPath)
          if (parentPath) setFocusedPath(parentPath)
          break
        }
      }
    },
    [visiblePaths, effectiveFocusedPath, expanded, onToggle, root, moveFocus],
  )

  if (!root) return null
  // hideRoot：跳过根节点本身，直接渲染其子项（子项 depth 从 0 起）。
  const topLevel = hideRoot && root.children ? root.children : [root]
  return (
    <div
      ref={treeRef}
      className={tree}
      role="tree"
      aria-label={label}
      data-testid="file-tree"
      onKeyDown={handleKeyDown}
      // DOM 焦点是漫游焦点的唯一事实源：把焦点交给某个节点（点击行、程序化
      // focus、浏览器恢复焦点）就同步过去，否则方向键会从「上一次方向键停留的
      // 位置」而不是用户眼前这个节点继续走。
      //
      // 只在真的换了节点时写状态：焦点同步 effect 自己也会 focus(effective
      // path)，那一路的 focusin 必须短路，否则来回写状态形成回环。
      onFocus={(e) => {
        const item = (e.target as Element).closest?.('[role="treeitem"]') as HTMLElement | null
        const path = item?.dataset.path
        if (path && path !== effectiveFocusedPath) setFocusedPath(path)
      }}
    >
      {topLevel.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          selected={selected}
          focusedPath={effectiveFocusedPath}
          loadingPaths={loadingPaths}
          onToggle={onToggle}
          onSelect={onSelect}
          directoryClickMode={directoryClickMode}
          onMention={onMention}
          onDelete={onDelete}
          gitStatusMap={gitStatusMap}
        />
      ))}
    </div>
  )
}

/** 按 DOM 顺序（= 视觉缩进顺序）收集当前可见的节点路径。折叠的子节点不在其中。 */
function collectVisiblePaths(root: TreeNode, expanded: Set<string>, hideRoot: boolean): string[] {
  const topLevel = hideRoot && root.children ? root.children : [root]
  const out: string[] = []
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      out.push(n.path)
      if (n.type !== 'file' && expanded.has(n.path) && n.children) walk(n.children)
    }
  }
  walk(topLevel)
  return out
}

/** 按路径找节点。 */
function findNode(root: TreeNode, path: string): TreeNode | null {
  if (root.path === path) return root
  for (const c of root.children ?? []) {
    const hit = findNode(c, path)
    if (hit) return hit
  }
  return null
}

/** 父节点路径。顶层节点返回 null；根路径 '.' 的直接子节点也返回 null。 */
function parentOf(path: string): string | null {
  const i = path.lastIndexOf('/')
  if (i <= 0) return null
  return path.slice(0, i)
}

/**
 * CSS.escape 在 happy-dom 下不保证存在，而路径里必然含 `.`、`/` 等选择器
 * 元字符（`.c0de/config.json`），不过滤会直接让 querySelector 抛错。
 */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
}

type TreeNodeProps = {
  node: TreeNode
  depth: number
  expanded: Set<string>
  selected: string | null
  /** 漫游焦点所在路径：整棵树只有它是 tabIndex=0，其余为 -1。 */
  focusedPath: string | null
  loadingPaths: Set<string>
  onToggle: (path: string) => void
  onSelect: (path: string) => void
  directoryClickMode: 'select' | 'toggle'
  onMention?: (path: string) => void
  onDelete?: (path: string) => void
  gitStatusMap?: Record<string, GitStatusCode>
}

const TreeNode = memo(function TreeNode({
  node,
  depth,
  expanded,
  selected,
  focusedPath,
  loadingPaths,
  onToggle,
  onSelect,
  directoryClickMode,
  onMention,
  onDelete,
  gitStatusMap,
}: TreeNodeProps) {
  const isFile = node.type === 'file'
  const isExpanded = expanded.has(node.path)
  const isLoading = loadingPaths.has(node.path)
  const isSelected = selected === node.path
  const isFocused = focusedPath === node.path
  const hasChildren = node.children !== undefined
  const gitCode = resolveGitStatus(node.path, isFile, gitStatusMap)
  return (
    <div
      role="treeitem"
      aria-expanded={isFile ? undefined : isExpanded}
      aria-level={depth + 1}
      aria-selected={isSelected}
      data-path={node.path}
      data-focused={isFocused ? 'true' : undefined}
      tabIndex={isFocused ? 0 : -1}
    >
      <div
        className={`${row} ${isSelected ? selectedRow : ''} ${gitCode ? gitClass(gitCode) : ''} ${node.ignored ? gitIgnored : ''}`}
        data-git-status={gitCode ?? undefined}
        data-ignored={node.ignored ? '' : undefined}
      >
        {isFile ? (
          <span className={toggle} aria-hidden="true" />
        ) : (
          <button
            type="button"
            className={toggleBtn}
            onClick={() => onToggle(node.path)}
            aria-label={isExpanded ? '折叠' : '展开'}
            data-testid={`toggle-${node.path}`}
          >
            {hasChildren ? (isExpanded ? '▼' : '▶') : ''}
          </button>
        )}
        <button
          type="button"
          className={`${row} ${rowBtn}`}
          onClick={() =>
            isFile
              ? onSelect(node.path)
              : directoryClickMode === 'toggle'
                ? onToggle(node.path)
                : onSelect(node.path)
          }
          data-testid={`node-${node.path}`}
          data-selected={isSelected ? '' : undefined}
        >
          <span>{isFile ? '📄' : isExpanded ? '📂' : '📁'}</span>
          <span>{node.name}</span>
        </button>
        {onMention && (
          <button
            type="button"
            className={mentionBtn}
            data-mention-btn
            data-testid={`mention-${node.path}`}
            aria-label={`引用 ${node.name} 到输入框`}
            onClick={(e) => {
              e.stopPropagation()
              onMention(node.path)
            }}
          >
            @
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            className={deleteBtn}
            data-delete-btn
            data-testid={`delete-${node.path}`}
            aria-label={`删除 ${node.name}`}
            onClick={(e) => {
              e.stopPropagation()
              onDelete(node.path)
            }}
          >
            🗑
          </button>
        )}
      </div>
      {!isFile && isExpanded && (
        // biome-ignore lint/a11y/useSemanticElements: role="group" 是 ARIA tree 的层级容器（treeitem 靠它确定归属），fieldset 会变成表单分组
        <div className={childList} role="group">
          {hasChildren && node.children && node.children.length > 0 ? (
            node.children.map((c) => (
              <TreeNode
                key={c.path}
                node={c}
                depth={depth + 1}
                expanded={expanded}
                selected={selected}
                focusedPath={focusedPath}
                loadingPaths={loadingPaths}
                onToggle={onToggle}
                onSelect={onSelect}
                directoryClickMode={directoryClickMode}
                onMention={onMention}
                onDelete={onDelete}
                gitStatusMap={gitStatusMap}
              />
            ))
          ) : isLoading ? (
            <div className={hint}>加载中…</div>
          ) : (
            <div className={hint}>（空）</div>
          )}
        </div>
      )}
    </div>
  )
})

export type { FileTreeProps }
