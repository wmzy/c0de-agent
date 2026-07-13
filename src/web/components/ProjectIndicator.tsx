import { css } from '@linaria/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProjects } from '../hooks/useSession.js'
import { fileAPI } from '../services/file.js'
import { AddProjectDialog } from './AddProjectDialog.js'
import { DropdownMenu } from './DropdownMenu.js'

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

/** TopBar 内联模式：无边框、无背景、零 padding，与品牌并排。 */
const indicatorInline = css`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: none;
  font-size: 13px;
  color: var(--text-secondary);
  background: transparent;
  margin-left: 4px;
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

const caret = css`
  font-size: 10px;
  opacity: 0.5;
  margin-left: 1px;
`

/** 右侧操作区：margin-left:auto 把内容推到指示器最右（如文件 tab 的提交按钮）。 */
const actionsWrap = css`
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
`

// ---- 下拉菜单项样式 ----

const menuItem = css`
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 12px;
  border: none;
  background: none;
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  &:hover {
    background: var(--bg-secondary);
  }
`

const menuItemActive = css`
  font-weight: 600;
  color: var(--primary);
`

const menuItemCheck = css`
  width: 14px;
  flex-shrink: 0;
  text-align: center;
`

const menuItemSub = css`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
`

const menuItemHint = css`
  font-size: 11px;
  color: var(--text-secondary);
  opacity: 0.7;
  flex-shrink: 0;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
`

const footerBtn = css`
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: none;
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: var(--text-secondary);
  cursor: pointer;
  &:hover {
    background: var(--bg-secondary);
    color: var(--primary);
  }
`

const branchInput = css`
  width: 100%;
  padding: 6px 12px;
  border: none;
  border-bottom: 1px solid var(--border);
  font: inherit;
  font-size: 13px;
  outline: none;
  background: var(--bg);
  color: var(--text);
`

const branchInputError = css`
  padding: 4px 12px;
  font-size: 11px;
  color: var(--error);
`

/**
 * 项目指示器：项目名 + git 分支均可点击下拉切换，各带"添加"按钮。
 * - 项目下拉：列出所有项目，点击导航到 `/projects/:id`，底部"添加项目"打开对话框。
 * - 分支下拉：列出本地分支，点击 checkout 切换，底部可输入新分支名创建并切换。
 * 可选 actions 渲染在右侧（如提交按钮）。
 */
export function ProjectIndicator({
  projectId,
  actions,
  variant = 'bar',
}: {
  projectId: string
  actions?: ReactNode
  variant?: 'bar' | 'inline'
}) {
  const cls = variant === 'inline' ? indicatorInline : indicator
  const { data: projects } = useProjects()
  const project = projects?.find((p) => p.id === projectId)
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [showAddProject, setShowAddProject] = useState(false)

  // hover 分支名展示最后一次提交信息
  const gitLastCommitQ = useQuery({
    queryKey: ['files', 'git-last-commit', projectId],
    queryFn: () => fileAPI.gitLastCommit(projectId),
    refetchInterval: 30_000,
    enabled: !!project?.gitBranch,
  })
  const lastCommit = gitLastCommitQ.data?.commit ?? null

  // 分支列表（下拉打开时按需加载）
  const [branchesOpen, setBranchesOpen] = useState(false)
  const branchesQ = useQuery({
    queryKey: ['files', 'git-branches', projectId],
    queryFn: () => fileAPI.gitBranches(projectId),
    enabled: branchesOpen,
  })

  // 切换分支后刷新所有 git 相关查询 + projects（withBranch 读实时分支）
  const invalidateGitQueries = () => {
    qc.invalidateQueries({ queryKey: ['projects'] })
    qc.invalidateQueries({ queryKey: ['files', 'git-status', projectId] })
    qc.invalidateQueries({ queryKey: ['files', 'git-branch', projectId] })
    qc.invalidateQueries({ queryKey: ['files', 'git-last-commit', projectId] })
    qc.invalidateQueries({ queryKey: ['files', 'git-branches', projectId] })
  }

  const checkoutMut = useMutation({
    mutationFn: (branch: string) => fileAPI.gitCheckout(projectId, branch),
    onSuccess: invalidateGitQueries,
  })

  const createBranchMut = useMutation({
    mutationFn: (name: string) => fileAPI.gitBranchCreate(projectId, name),
    onSuccess: invalidateGitQueries,
  })

  if (!project) {
    return (
      <div className={cls} data-testid="project-indicator">
        <span className={projectIcon}>{'\u{1F4C2}'}</span>
        <span className={projectName}>默认工作区</span>
      </div>
    )
  }

  return (
    <div className={cls} data-testid="project-indicator">
      {/* 项目名下拉 */}
      <DropdownMenu
        testId="project-dropdown"
        trigger={
          <>
            <span className={projectIcon}>{'\u{1F4C2}'}</span>
            <span className={projectName}>{project.name ?? '未命名项目'}</span>
            <span className={caret}>{'\u25BE'}</span>
          </>
        }
        footer={(close) => (
          <button
            type="button"
            className={footerBtn}
            onClick={() => {
              close()
              setShowAddProject(true)
            }}
            data-testid="project-dropdown-add"
          >
            {'\uFF0B'} 添加项目
          </button>
        )}
      >
        {(close) =>
          (projects ?? []).map((p) => (
            <button
              key={p.id}
              type="button"
              className={`${menuItem} ${p.id === projectId ? menuItemActive : ''}`}
              onClick={() => {
                close()
                navigate(`/projects/${p.id}`)
              }}
              data-testid={`project-dropdown-item-${p.id}`}
            >
              <span className={menuItemCheck}>{p.id === projectId ? '\u2713' : ''}</span>
              <span className={menuItemSub}>{p.name ?? '未命名项目'}</span>
            </button>
          ))
        }
      </DropdownMenu>

      {/* 分支下拉 */}
      {project.gitBranch ? (
        <DropdownMenu
          testId="branch-dropdown"
          onOpenChange={setBranchesOpen}
          trigger={
            <span
              className={branchTag}
              data-testid="project-branch"
              title={
                lastCommit
                  ? `${lastCommit.subject}\n${lastCommit.author} · ${lastCommit.date}${lastCommit.hash ? ` · ${lastCommit.hash}` : ''}`
                  : undefined
              }
            >
              {project.gitBranch}
              <span className={caret}>{'\u25BE'}</span>
            </span>
          }
          footer={() => (
            <NewBranchForm
              onCreate={(name) => createBranchMut.mutate(name)}
              pending={createBranchMut.isPending}
              error={createBranchMut.error ? String(createBranchMut.error.message) : null}
            />
          )}
        >
          {() =>
            (branchesQ.data?.branches ?? []).map((b) => (
              <button
                key={b.name}
                type="button"
                className={`${menuItem} ${b.current ? menuItemActive : ''}`}
                onClick={() => {
                  if (!b.current) checkoutMut.mutate(b.name)
                }}
                disabled={b.current || checkoutMut.isPending}
                data-testid={`branch-dropdown-item-${b.name}`}
              >
                <span className={menuItemCheck}>{b.current ? '\u2713' : ''}</span>
                <span className={menuItemSub}>{b.name}</span>
                {b.lastSubject ? (
                  <span className={menuItemHint} title={b.lastSubject}>
                    {b.lastSubject}
                  </span>
                ) : null}
              </button>
            ))
          }
        </DropdownMenu>
      ) : null}

      {actions ? <span className={actionsWrap}>{actions}</span> : null}

      {showAddProject && (
        <AddProjectDialog
          onClose={() => setShowAddProject(false)}
          onCreated={(p) => {
            setShowAddProject(false)
            navigate(`/projects/${p.id}`)
          }}
        />
      )}
    </div>
  )
}

/** 新建分支表单：输入框 + 确认，Enter 提交。 */
function NewBranchForm({
  onCreate,
  pending,
  error,
}: {
  onCreate: (name: string) => void
  pending: boolean
  error: string | null
}) {
  const [name, setName] = useState('')

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed || pending) return
    onCreate(trimmed)
    setName('')
  }

  return (
    <div>
      <input
        className={branchInput}
        placeholder="新分支名…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
        data-testid="branch-new-input"
        disabled={pending}
      />
      {error ? <div className={branchInputError}>{error}</div> : null}
    </div>
  )
}
