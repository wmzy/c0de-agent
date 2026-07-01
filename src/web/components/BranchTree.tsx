import { css } from '@linaria/core'
import type { SessionTreeNode } from '../types/index.js'

const node = css`
  padding: 1px 0;
`

const row = css`
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  cursor: pointer;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  text-align: left;
  font-size: 13px;
  min-height: 0;
  min-width: 0;
  &:hover {
    background: var(--bg-secondary);
  }
`

const active = css`
  background: var(--bg-secondary);
  font-weight: 600;
`

const iconCls = css`
  flex-shrink: 0;
`

const titleCls = css`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const childList = css`
  padding-left: 16px;
  border-left: 1px solid var(--border);
  margin-left: 8px;
`

export function BranchTree({
  nodes,
  activeId,
  onSelect,
}: {
  nodes: SessionTreeNode[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div data-testid="branch-tree">
      {nodes.map((n) => (
        <TreeNode key={n.session.id} node={n} activeId={activeId} depth={0} onSelect={onSelect} />
      ))}
    </div>
  )
}

function TreeNode({
  node: n,
  activeId,
  depth,
  onSelect,
}: {
  node: SessionTreeNode
  activeId: string | null
  depth: number
  onSelect: (id: string) => void
}) {
  const isActive = n.session.id === activeId
  return (
    <div className={node}>
      <button
        className={`${row} ${isActive ? active : ''}`}
        onClick={() => onSelect(n.session.id)}
        type="button"
        data-testid={`node-${n.session.id}`}
      >
        <span className={iconCls}>{n.children.length > 0 ? '📂' : '💬'}</span>
        <span className={titleCls}>{n.session.title}</span>
      </button>
      {n.children.length > 0 && (
        <div className={childList}>
          {n.children.map((c) => (
            <TreeNode
              key={c.session.id}
              node={c}
              activeId={activeId}
              depth={depth + 1}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}
