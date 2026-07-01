import { css } from '@linaria/core'
import { Trash2 } from 'lucide-react'
import type { SessionTreeNode } from '../types/index.js'

const node = css`
  padding: 1px 0;
`

const rowWrap = css`
  display: flex;
  align-items: center;
  gap: 2px;
  width: 100%;
  padding: 1px 4px 1px 0;
  border-radius: 4px;
  &:hover,
  &:focus-within {
    background: var(--bg-secondary);
    & [data-delete-btn] {
      opacity: 1;
    }
  }
`

const active = css`
  background: var(--bg-secondary);
`

const selectBtn = css`
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  min-height: auto;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  text-align: left;
  font-size: 13px;
  cursor: pointer;
`

const titleActive = css`
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

const delBtn = css`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  min-height: auto;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.12s ease,
    color 0.12s ease;
  &:hover {
    color: var(--danger, #e5484d);
  }
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
  onDelete,
}: {
  nodes: SessionTreeNode[]
  activeId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <div data-testid="branch-tree">
      {nodes.map((n) => (
        <TreeNode
          key={n.session.id}
          node={n}
          activeId={activeId}
          depth={0}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}

function TreeNode({
  node: n,
  activeId,
  depth,
  onSelect,
  onDelete,
}: {
  node: SessionTreeNode
  activeId: string | null
  depth: number
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}) {
  const isActive = n.session.id === activeId
  return (
    <div className={node}>
      <div className={`${rowWrap} ${isActive ? active : ''}`}>
        <button
          type="button"
          className={selectBtn}
          onClick={() => onSelect(n.session.id)}
          data-testid={`node-${n.session.id}`}
        >
          <span className={iconCls}>{n.children.length > 0 ? '📂' : '💬'}</span>
          <span className={`${titleCls} ${isActive ? titleActive : ''}`}>{n.session.title}</span>
        </button>
        <button
          type="button"
          className={delBtn}
          data-delete-btn
          onClick={(e) => {
            e.stopPropagation()
            onDelete(n.session.id)
          }}
          aria-label={`删除会话 ${n.session.title}`}
          data-testid={`delete-${n.session.id}`}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {n.children.length > 0 && (
        <div className={childList}>
          {n.children.map((c) => (
            <TreeNode
              key={c.session.id}
              node={c}
              activeId={activeId}
              depth={depth + 1}
              onSelect={onSelect}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}
