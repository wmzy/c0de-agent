import { css } from '@linaria/core'
import { useState } from 'react'
import { BranchTree } from '../components/BranchTree.js'
import {
  useDeletedSessions,
  useDeleteSession,
  useRestoreSession,
  useSessionTree,
} from '../hooks/useSession.js'
import type { SessionTreeNode } from '../types/index.js'

const panel = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`

const header = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--border);
`

const addBtn = css`
  flex-shrink: 0;
  min-height: auto;
  min-width: auto;
  padding: 4px 8px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  &:hover {
    border-color: var(--primary);
    color: var(--primary);
  }
`

const recycleBtn = css`
  flex-shrink: 0;
  min-height: auto;
  min-width: auto;
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  &[aria-pressed='true'] {
    color: var(--primary);
    border-color: var(--primary);
  }
`

const empty = css`
  padding: 16px 12px;
  color: var(--text);
  opacity: 0.6;
  font-size: 13px;
  text-align: center;
`

const errorBar = css`
  padding: 6px 12px;
  font-size: 12px;
  color: var(--error);
  border-bottom: 1px solid var(--border);
`

const deletedRow = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--text);
  border-bottom: 1px solid var(--border);

  & > span:first-child {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  & > span:nth-child(2) {
    color: var(--text-secondary);
    font-size: 11px;
    flex-shrink: 0;
  }
`

const restoreBtn = css`
  flex-shrink: 0;
  min-height: auto;
  min-width: auto;
  padding: 2px 8px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--primary);
  cursor: pointer;
  &:hover {
    border-color: var(--primary);
  }
`

/** 按项目 id 过滤会话树（以根会话的 projectId 为准）。项目为路由顶级维度，仅显示归属本项目的会话。 */
function filterTree(tree: SessionTreeNode[], projectId: string): SessionTreeNode[] {
  return tree.filter((node) => node.session.projectId === projectId)
}

export function SessionList({
  projectId,
  activeId,
  onSelect,
  onNewSession,
  onDeleted,
}: {
  projectId: string
  activeId: string | null
  onSelect: (id: string) => void
  /** 新建会话：仅前端导航到草稿页，不创建会话（首条消息发送时才创建）。 */
  onNewSession: () => void
  /** 删除会话后回调（参数为被删 id），用于父级在删除当前会话时跳回草稿页。 */
  onDeleted?: (id: string) => void
}) {
  const { data: tree, isLoading } = useSessionTree()
  const del = useDeleteSession()
  const [showRecycle, setShowRecycle] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const visibleTree = tree ? filterTree(tree, projectId) : []

  const handleDelete = (id: string) => {
    setDeleteError(null)
    // fail-closed：confirm 不可用时宁可阻止删除（不可恢复操作），与 FileBrowser 惯例一致
    if (!window.confirm('删除该会话及其全部消息？将移入回收站，30 天内可恢复。')) return
    del.mutate(id, {
      onSuccess: () => onDeleted?.(id),
      onError: (e: unknown) => {
        setDeleteError(e instanceof Error ? e.message : String(e))
      },
    })
  }

  return (
    <div className={panel}>
      <div className={header}>
        <span>会话</span>
        <button
          type="button"
          className={recycleBtn}
          aria-pressed={showRecycle}
          onClick={() => {
            setShowRecycle((v) => !v)
            setDeleteError(null)
          }}
          data-testid="recycle-toggle"
        >
          回收站
        </button>
        <button type="button" className={addBtn} onClick={onNewSession} data-testid="new-session">
          + 新建
        </button>
      </div>
      {deleteError && (
        <div className={errorBar} data-testid="delete-error">
          删除失败：{deleteError}
        </div>
      )}
      {isLoading && !showRecycle ? <div className={empty}>加载中…</div> : null}
      {!showRecycle ? (
        <>
          {!isLoading && visibleTree.length === 0 ? (
            <div className={empty}>该项目下暂无会话</div>
          ) : null}
          {visibleTree.length > 0 && (
            <BranchTree
              nodes={visibleTree}
              activeId={activeId}
              onSelect={onSelect}
              onDelete={handleDelete}
            />
          )}
        </>
      ) : (
        <RecycleBin />
      )}
    </div>
  )
}

/** 回收站列表：软删除会话 + 恢复按钮。 */
function RecycleBin() {
  const { data: deleted, isLoading } = useDeletedSessions()
  const restore = useRestoreSession()
  const [error, setError] = useState<string | null>(null)

  if (isLoading) return <div className={empty}>加载中…</div>
  if (!deleted || deleted.length === 0) return <div className={empty}>回收站为空</div>

  return (
    <div>
      {error && (
        <div className={errorBar} data-testid="restore-error">
          恢复失败：{error}
        </div>
      )}
      {deleted.map((s) => (
        <div key={s.id} className={deletedRow}>
          <span title={s.title}>{s.title}</span>
          <span>{s.deletedAt ? new Date(s.deletedAt).toLocaleDateString() : ''}</span>
          <button
            type="button"
            className={restoreBtn}
            onClick={() =>
              restore.mutate(s.id, {
                onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
              })
            }
            data-testid={`restore-${s.id}`}
          >
            恢复
          </button>
        </div>
      ))}
    </div>
  )
}
