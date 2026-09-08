import { css } from '@linaria/core'
import { Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { SessionTreeNode, SessionUsage } from '../types/index.js'

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

const renameForm = css`
  flex: 1;
  min-width: 0;
  display: flex;
`

const renameInput = css`
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: 13px;
  border: 1px solid var(--primary);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  outline: none;
`

const usageBadge = css`
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
`

/** 会话级用量徽标：总 token（输入+输出+缓存读）；无调用时不渲染。
 *  P0 审查：列表视图此前无法回答「会话花了多少 token」——tree 载荷现在携带聚合值。 */
function UsageBadge({ usage }: { usage: SessionUsage }) {
  if (!usage || usage.calls === 0) return null
  const total = usage.inputTokens + usage.outputTokens + usage.cacheRead
  return (
    <span
      className={usageBadge}
      data-testid="usage-badge"
      title="本会话累计 token（输入+输出+缓存读）"
    >
      {total.toLocaleString('en-US')} tok
    </span>
  )
}

export function BranchTree({
  nodes,
  activeId,
  onSelect,
  onDelete,
  onRename,
}: {
  nodes: SessionTreeNode[]
  activeId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  /** P2-5：重命名会话（返回 false 表示取消/失败，父级决定是否刷新）。 */
  onRename?: (id: string, current: string) => Promise<boolean>
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
          onRename={onRename}
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
  onRename,
}: {
  node: SessionTreeNode
  activeId: string | null
  depth: number
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename?: (id: string, current: string) => Promise<boolean>
}) {
  const isActive = n.session.id === activeId
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(n.session.title)
  const [pending, setPending] = useState(false)

  const commitRename = async () => {
    const next = title.trim()
    if (!next || next === n.session.title) {
      setTitle(n.session.title)
      setRenaming(false)
      return
    }
    setPending(true)
    const ok = onRename ? await onRename(n.session.id, next) : false
    setPending(false)
    if (!ok) {
      setTitle(n.session.title)
    }
    setRenaming(false)
  }

  return (
    <div className={node}>
      <div className={`${rowWrap} ${isActive ? active : ''}`}>
        {renaming ? (
          <form
            className={renameForm}
            onSubmit={(e) => {
              e.preventDefault()
              void commitRename()
            }}
            data-testid={`rename-form-${n.session.id}`}
          >
            <input
              ref={(el) => {
                // a11y：避免 autoFocus，挂载后程序化聚焦
                el?.focus()
              }}
              className={renameInput}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={pending}
              maxLength={120}
              aria-label={`重命名会话 ${n.session.title}`}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setTitle(n.session.title)
                  setRenaming(false)
                }
              }}
            />
          </form>
        ) : (
          <>
            <button
              type="button"
              className={selectBtn}
              onClick={() => onSelect(n.session.id)}
              data-testid={`node-${n.session.id}`}
            >
              <span className={iconCls}>{n.children.length > 0 ? '📂' : '💬'}</span>
              <span className={`${titleCls} ${isActive ? titleActive : ''}`}>
                {n.session.title}
              </span>
              <UsageBadge usage={n.usage} />
            </button>
            {onRename && (
              <button
                type="button"
                className={delBtn}
                data-rename-btn
                onClick={(e) => {
                  e.stopPropagation()
                  setTitle(n.session.title)
                  setRenaming(true)
                }}
                aria-label={`重命名会话 ${n.session.title}`}
                title="重命名会话"
                data-testid={`rename-${n.session.id}`}
              >
                <Pencil size={13} />
              </button>
            )}
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
          </>
        )}
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
              onRename={onRename}
            />
          ))}
        </div>
      )}
    </div>
  )
}
