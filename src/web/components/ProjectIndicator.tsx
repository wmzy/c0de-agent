import { css } from '@linaria/core'
import { useProjects } from '../hooks/useSession.js'

const indicator = css`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  color: var(--text);
  background: var(--bg-secondary);
`

const projectIcon = css`
  opacity: 0.7;
  flex-shrink: 0;
`

const projectName = css`
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const branchTag = css`
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg);
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
`

/** 侧栏项目指示器：显示路由当前项目名 + git 分支（由 projectId 驱动，非服务端工作区）。 */
export function ProjectIndicator({ projectId }: { projectId: string }) {
  const { data: projects } = useProjects()
  const project = projects?.find((p) => p.id === projectId)

  if (!project) {
    return (
      <div className={indicator} data-testid="project-indicator">
        <span className={projectIcon}>{'\u{1F4C2}'}</span>
        <span className={projectName}>默认工作区</span>
      </div>
    )
  }

  return (
    <div className={indicator} data-testid="project-indicator">
      <span className={projectIcon}>{'\u{1F4C2}'}</span>
      <span className={projectName}>{project.name ?? '未命名项目'}</span>
      {project.gitBranch ? <span className={branchTag}>{project.gitBranch}</span> : null}
    </div>
  )
}
