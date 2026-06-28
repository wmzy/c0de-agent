import { css } from '@linaria/core'
import { useState } from 'react'
import { BranchTree } from '../components/BranchTree.js'
import { ProjectIndicator } from '../components/ProjectIndicator.js'
import { ProjectSwitcher } from '../components/ProjectSwitcher.js'
import type { Selection } from '../components/ProjectSwitcher.js'
import { useCreateSession, useDeleteSession, useProjects, useSessionTree } from '../hooks/useSession.js'
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
  padding: 12px;
  border-bottom: 1px solid var(--border);
`

const filterBar = css`
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
`

const empty = css`
  padding: 16px 12px;
  color: var(--text);
  opacity: 0.6;
  font-size: 13px;
  text-align: center;
`

/** 按选中项目过滤会话树（以根会话的 projectId 为准）。 */
function filterTree(tree: SessionTreeNode[], selection: Selection): SessionTreeNode[] {
  if (selection === 'ALL') return tree
  return tree.filter((node) => {
    const pid = node.session.projectId
    if (selection === 'UNASSIGNED') return pid === null
    return pid === selection
  })
}

export function SessionList({
  activeId,
  onSelect,
}: {
  activeId: string | null
  onSelect: (id: string) => void
}) {
  const { data: tree, isLoading } = useSessionTree()
  const { data: projects } = useProjects()
  const create = useCreateSession()
  const del = useDeleteSession()
  const [selection, setSelection] = useState<Selection>('ALL')

  const visibleTree = tree ? filterTree(tree, selection) : []
  const selectedProjectId = selection !== 'ALL' && selection !== 'UNASSIGNED' ? selection : undefined

  return (
    <div className={panel}>
      <ProjectIndicator />
      <div className={filterBar}>
        <ProjectSwitcher projects={projects ?? []} value={selection} onChange={setSelection} />
      </div>
      <div className={header}>
        <span>会话</span>
        <button
          type="button"
          onClick={() =>
            create.mutate(
              selectedProjectId ? { projectId: selectedProjectId } : undefined,
              { onSuccess: (s) => s && onSelect(s.id) },
            )
          }
          data-testid="new-session"
        >
          + 新建
        </button>
      </div>
      {isLoading ? <div className={empty}>加载中…</div> : null}
      {!isLoading && visibleTree.length === 0 ? (
        <div className={empty}>该项目下暂无会话</div>
      ) : null}
      {visibleTree.length > 0 && (
        <BranchTree nodes={visibleTree} activeId={activeId} onSelect={onSelect} />
      )}
      {activeId && (
        <button type="button" onClick={() => del.mutate(activeId)} style={{ margin: 12 }}>
          删除当前会话
        </button>
      )}
    </div>
  )
}
