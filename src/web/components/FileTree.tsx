import { css } from '@linaria/core'

/** 文件树节点。children 为 undefined 表示尚未加载子目录。type 缺省视为 directory（兼容目录选择器）。 */
export type TreeNode = {
  name: string
  path: string
  type?: 'file' | 'directory'
  children?: TreeNode[]
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
}

const tree = css`
  font-size: 13px;
  user-select: none;
`

const row = css`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  cursor: pointer;
  border-radius: 4px;
  &:hover {
    background: var(--bg-secondary);
  }
  /* hover 时显示 @ 引用按钮（通过 data-mention-btn 属性选择器） */
  &:hover [data-mention-btn] {
    opacity: 1;
  }
`

const selectedRow = css`
  background: var(--bg-secondary);
  font-weight: 600;
`

const toggle = css`
  width: 16px;
  text-align: center;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
  font-size: 10px;
`

const toggleBtn = css`
  width: 16px;
  text-align: center;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
  font-size: 10px;
  min-height: auto;
  min-width: auto;
`

const childList = css`
  padding-left: 16px;
  border-left: 1px solid var(--border);
  margin-left: 8px;
`

const hint = css`
  padding: 2px 8px 2px 28px;
  color: var(--text-secondary);
  font-size: 12px;
`

const mentionBtn = css`
  margin-left: auto;
  opacity: 0;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
  padding: 0 5px;
  min-height: auto;
  min-width: auto;
  flex-shrink: 0;
  transition: opacity 0.1s;
  &:hover {
    color: var(--primary);
    border-color: var(--primary);
  }
`

/**
 * 递归文件树：目录可展开（懒加载），文件为叶子节点。
 * directoryClickMode='select' 时点目录名=选中（目录选择器用法）；
 * 'toggle' 时点目录名=展开/折叠（文件浏览器用法）。
 */
export function FileTree({
  root,
  expanded,
  selected,
  loadingPaths,
  onToggle,
  onSelect,
  directoryClickMode = 'select',
  onMention,
}: FileTreeProps) {
  if (!root) return null
  return (
    <div className={tree} role="tree" data-testid="file-tree">
      {renderNode(
        root,
        0,
        expanded,
        selected,
        loadingPaths,
        onToggle,
        onSelect,
        directoryClickMode,
        onMention,
      )}
    </div>
  )
}

function renderNode(
  node: TreeNode,
  depth: number,
  expanded: Set<string>,
  selected: string | null,
  loadingPaths: Set<string>,
  onToggle: (path: string) => void,
  onSelect: (path: string) => void,
  directoryClickMode: 'select' | 'toggle',
  onMention?: (path: string) => void,
) {
  const isFile = node.type === 'file'
  const isExpanded = expanded.has(node.path)
  const isLoading = loadingPaths.has(node.path)
  const isSelected = selected === node.path
  const hasChildren = node.children !== undefined
  return (
    <div
      role="treeitem"
      aria-expanded={isFile ? undefined : isExpanded}
      tabIndex={-1}
      key={node.path}
    >
      <div
        className={`${row} ${isSelected ? selectedRow : ''}`}
        style={{ paddingLeft: depth * 16 + 8 }}
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
          className={row}
          style={{ flex: 1, padding: 0 }}
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
      </div>
      {!isFile && isExpanded && (
        <div className={childList}>
          {hasChildren && node.children && node.children.length > 0 ? (
            node.children.map((c) =>
              renderNode(
                c,
                depth + 1,
                expanded,
                selected,
                loadingPaths,
                onToggle,
                onSelect,
                directoryClickMode,
                onMention,
              ),
            )
          ) : isLoading ? (
            <div className={hint}>加载中…</div>
          ) : (
            <div className={hint}>（空）</div>
          )}
        </div>
      )}
    </div>
  )
}

export type { FileTreeProps }
