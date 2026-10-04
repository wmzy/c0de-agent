import { css } from '@linaria/core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from 'haze-ui'
import { useState } from 'react'
import { Dialog } from '@/components/Dialog.js'
import { DirectoryPicker } from '@/components/DirectoryPicker.js'
import { projectAPI } from '@/services/project.js'
import type { Project } from '@/types/index.js'

const hint = css`
  font-size: 12px;
  color: var(--haze-color-text-secondary);
`

const errorMsg = css`
  font-size: 12px;
  color: var(--haze-color-danger);
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
    <Dialog
      onClose={onClose}
      title="添加项目"
      testId="add-project-dialog"
      footer={
        <>
          <Button onClick={onClose} variant="outline">
            取消
          </Button>
          <Button
            onClick={submit}
            disabled={!directory.trim() || create.isPending}
            data-testid="add-project-confirm"
            variant="outline"
          >
            {create.isPending ? '创建中…' : '添加'}
          </Button>
        </>
      }
    >
      <DirectoryPicker
        value={directory}
        onChange={setDirectory}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
        placeholder="/path/to/your/project"
        testId="add-project-input"
        autoFocus
      />
      <div className={hint}>输入目录名可递归搜索深层目录，或在文件树中浏览选择。</div>
      {error ? <div className={errorMsg}>{error}</div> : null}
    </Dialog>
  )
}

export type { AddProjectDialogProps }
