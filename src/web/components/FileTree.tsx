import { css } from '@linaria/core'

/** 文件树节点。children 为 undefined 表示尚未加载子目录。 */
export type TreeNode = {
  name: string
  path: string
  children?: TreeNode[]
}

type FileTreeProps = {
  /** 根节点（当前已导航目录）。null 时不渲染。 */
  root: TreeNode | null
  /** 已展开的目录路径集合。 */
  expanded: Set<string>
  /** 当前选中目录路径。 */
  selected: string | null
  /** 正在加载子目录的节点路径集合。 */
  loadingPaths: Set<string>
  /** 展开/折叠节点（首次展开由父组件触发懒加载）。 */
  onToggle: (path: string) => void
  /** 选中目录。 */
  onSelect: (path: string) => void
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

/** 递归文件树：目录节点可展开（懒加载）与选中。仅渲染 directory（mode=directory）。 */
export function FileTree({
  root,
  expanded,
  selected,
  loadingPaths,
  onToggle,
  onSelect,
}: FileTreeProps) {
  if (!root) return null
  return (
    <div className={tree} role="tree" data-testid="file-tree">
      {renderNode(root, 0, expanded, selected, loadingPaths, onToggle, onSelect)}
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
) {
  const isExpanded = expanded.has(node.path)
  const isLoading = loadingPaths.has(node.path)
  const isSelected = selected === node.path
  const hasChildren = node.children !== undefined
  return (
    <div role="treeitem" aria-expanded={isExpanded} tabIndex={-1} key={node.path}>
      <div
        className={`${row} ${isSelected ? selectedRow : ''}`}
        style={{ paddingLeft: depth * 16 + 8 }}
      >
        <button
          type="button"
          className={toggle}
          onClick={() => onToggle(node.path)}
          aria-label={isExpanded ? '折叠' : '展开'}
          data-testid={`toggle-${node.path}`}
        >
          {hasChildren ? (isExpanded ? '▼' : '▶') : ''}
        </button>
        <button
          type="button"
          className={`${row}`}
          style={{ flex: 1, padding: 0 }}
          onClick={() => onSelect(node.path)}
          data-testid={`node-${node.path}`}
          data-selected={isSelected ? '' : undefined}
        >
          <span>{isExpanded ? '📂' : '📁'}</span>
          <span>{node.name}</span>
        </button>
      </div>
      {isExpanded && (
        <div className={childList}>
          {hasChildren && node.children && node.children.length > 0 ? (
            node.children.map((c) =>
              renderNode(c, depth + 1, expanded, selected, loadingPaths, onToggle, onSelect),
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
