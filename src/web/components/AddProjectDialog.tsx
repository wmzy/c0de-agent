import { css } from '@linaria/core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { projectAPI } from '../services/project.js'
import type { Project } from '../types/index.js'
import { PathPicker } from './PathPicker.js'

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

type AddProjectDialogProps = {
  onClose: () => void
  /** 创建成功回调（通常用于切换到新项目）。 */
  onCreated?: (project: Project) => void
}

/** 「添加项目」弹窗：输入目录路径，解析并创建项目记录。 */
export function AddProjectDialog({ onClose, onCreated }: AddProjectDialogProps) {
  const qc = useQueryClient()
  const [directory, setDirectory] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: (dir: string) => projectAPI.fromDirectory(dir),
    onSuccess: (project) => {
      // 刷新项目列表 + 当前项目指示器
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['project', 'current'] })
      onCreated?.(project)
      onClose()
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    },
  })

  const submit = () => {
    // 去掉尾部斜杠后提交
    const dir = directory.trim().replace(/\/+$/, '')
    if (!dir) return
    setError(null)
    create.mutate(dir)
  }

  return (
    <div className={overlay} role="presentation" data-testid="add-project-dialog">
      <div className={dialog}>
        <div className={title}>添加项目</div>
        <PathPicker
          value={directory}
          onChange={setDirectory}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onClose()
          }}
          placeholder="/path/to/your/project"
          testId="add-project-input"
          autoFocus
        />
        <div className={hint}>输入项目目录路径，自动补全子目录；将解析 git 信息并注册。</div>
        {error ? <div className={errorMsg}>{error}</div> : null}
        <div className={actions}>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!directory.trim() || create.isPending}
            data-testid="add-project-confirm"
          >
            {create.isPending ? '创建中…' : '添加'}
          </button>
        </div>
      </div>
    </div>
  )
}

export type { AddProjectDialogProps }
