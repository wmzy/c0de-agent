import { css } from '@linaria/core'
import { useState } from 'react'
import { AddProjectDialog } from '../components/AddProjectDialog.js'
import { BranchTree } from '../components/BranchTree.js'
import { ProjectIndicator } from '../components/ProjectIndicator.js'
import { ProjectSwitcher } from '../components/ProjectSwitcher.js'
import {
  useCreateSession,
  useDeleteSession,
  useProjects,
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
  padding: 12px;
  border-bottom: 1px solid var(--border);
`

const filterBar = css`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
`

const switcherWrap = css`
  flex: 1;
  min-width: 0;
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

const empty = css`
  padding: 16px 12px;
  color: var(--text);
  opacity: 0.6;
  font-size: 13px;
  text-align: center;
`

/** 按项目 id 过滤会话树（以根会话的 projectId 为准）。项目为路由顶级维度，仅显示归属本项目的会话。 */
function filterTree(tree: SessionTreeNode[], projectId: string): SessionTreeNode[] {
  return tree.filter((node) => node.session.projectId === projectId)
}

export function SessionList({
  projectId,
  activeId,
  onSelect,
  onProjectChange,
}: {
  projectId: string
  activeId: string | null
  onSelect: (id: string) => void
  onProjectChange: (projectId: string) => void
}) {
  const { data: tree, isLoading } = useSessionTree()
  const { data: projects } = useProjects()
  const create = useCreateSession()
  const del = useDeleteSession()
  const [showAdd, setShowAdd] = useState(false)

  const visibleTree = tree ? filterTree(tree, projectId) : []

  return (
    <div className={panel}>
      <ProjectIndicator />
      <div className={filterBar}>
        <div className={switcherWrap}>
          <ProjectSwitcher projects={projects ?? []} value={projectId} onChange={onProjectChange} />
        </div>
        <button
          type="button"
          className={addBtn}
          onClick={() => setShowAdd(true)}
          data-testid="add-project"
          aria-label="添加项目"
        >
          + 项目
        </button>
      </div>
      {showAdd && (
        <AddProjectDialog
          onClose={() => setShowAdd(false)}
          onCreated={(p) => onProjectChange(p.id)}
        />
      )}
      <div className={header}>
        <span>会话</span>
        <button
          type="button"
          onClick={() =>
            create.mutate(
              { projectId },
              {
                onSuccess: (s) => s && onSelect(s.id),
              },
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
