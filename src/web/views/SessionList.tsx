import { css } from '@linaria/core'
import { BranchTree } from '../components/BranchTree.js'
import { useCreateSession, useDeleteSession, useSessionTree } from '../hooks/useSession.js'

const panel = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`

const header = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  border-bottom: 1px solid var(--border);
`

export function SessionList({
  activeId,
  onSelect,
}: {
  activeId: string | null
  onSelect: (id: string) => void
}) {
  const { data: tree, isLoading } = useSessionTree()
  const create = useCreateSession()
  const del = useDeleteSession()

  return (
    <div className={panel}>
      <div className={header}>
        <span>会话</span>
        <button
          type="button"
          onClick={() => create.mutate(undefined, { onSuccess: (s) => s && onSelect(s.id) })}
          data-testid="new-session"
        >
          + 新建
        </button>
      </div>
      {isLoading ? <div style={{ padding: 12 }}>加载中…</div> : null}
      {tree && <BranchTree nodes={tree} activeId={activeId} onSelect={onSelect} />}
      {activeId && (
        <button type="button" onClick={() => del.mutate(activeId)} style={{ margin: 12 }}>
          删除当前会话
        </button>
      )}
    </div>
  )
}
