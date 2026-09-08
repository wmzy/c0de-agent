import { css } from '@linaria/core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { projectAPI } from '../services/project.js'
import type { Project } from '../types/index.js'
import { DirectoryPicker } from './DirectoryPicker.js'

const overlay = css`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
`

const dialog = css`
  background: var(--bg);
  border-radius: 8px;
  padding: 20px;
  width: min(480px, 92vw);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 12px;
`

const title = css`
  font-size: 16px;
  font-weight: 600;
`

const hint = css`
  font-size: 12px;
  color: var(--text-secondary);
`

const errorMsg = css`
  font-size: 12px;
  color: var(--error);
`

const actions = css`
  display: flex;
  gap: 8px;
  justify-content: flex-end;
`

type RelocateProjectDialogProps = {
  /** 待重新定位的项目（worktree 已失效）。 */
  project: Project
  onClose: () => void
  /** 迁移成功回调（项目身份已更换为新目录，通常需导航到新 id）。 */
  onRelocated?: (project: Project) => void
}

/**
 * A1：「重新定位项目」弹窗——目录被移动/重命名后的恢复通道。
 * 输入新目录路径，后端把会话与看板整体迁移到新目录身份（替代删除项目）。
 */
export function RelocateProjectDialog({
  project,
  onClose,
  onRelocated,
}: RelocateProjectDialogProps) {
  const qc = useQueryClient()
  const [directory, setDirectory] = useState('')
  const [error, setError] = useState<string | null>(null)

  const relocate = useMutation({
    mutationFn: (dir: string) => projectAPI.relocate(project.id, dir),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['project', 'current'] })
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ['sessions', 'tree'] })
      onRelocated?.(res.project)
      onClose()
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    },
  })

  const submit = () => {
    const dir = directory.trim().replace(/\/+$/, '')
    if (!dir) return
    setError(null)
    relocate.mutate(dir)
  }

  return (
    <div className={overlay} role="presentation" data-testid="relocate-project-dialog">
      <div className={dialog}>
        <div className={title}>重新定位项目</div>
        <DirectoryPicker
          value={directory}
          onChange={setDirectory}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onClose()
          }}
          placeholder="/new/path/to/project"
          testId="relocate-project-input"
          autoFocus
        />
        <div className={hint}>
          项目目录已失效（被移动或重命名）。输入新目录路径后，会话与看板将整体迁移到新位置——无需删除项目，看板不会丢失。
        </div>
        {error ? <div className={errorMsg}>{error}</div> : null}
        <div className={actions}>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!directory.trim() || relocate.isPending}
            data-testid="relocate-project-confirm"
          >
            {relocate.isPending ? '迁移中…' : '重新定位'}
          </button>
        </div>
      </div>
    </div>
  )
}
