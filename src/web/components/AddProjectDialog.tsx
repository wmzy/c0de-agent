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
      // APIError 现在是真正的 Error（services/api.ts），常规写法即可拿到后端原因。
      setError(err instanceof Error ? err.message : String(err))
    },
  })

  const submit = () => {
    // 去掉尾部斜杠后提交
    const dir = directory.trim().replace(/\/+$/, '')
    if (!dir) return
    // 在飞时回车/再点确认会排第二次 mutate（重复建项目），一并挡掉。
    if (create.isPending) return
    setError(null)
    create.mutate(dir)
  }

  // 请求在飞时不给关闭的出口：Esc / 点背景 / ✕ / 取消都走这里。失败原因只渲染
  // 在这块面板里，中途关掉它就等于把失败原因一起关掉——实测目录建项目时按 Esc，
  // 服务端随后 500，用户看到的是「点了添加，什么也没发生」，项目也没建出来。
  const dismiss = () => {
    if (create.isPending) return
    onClose()
  }

  return (
    <Dialog
      onClose={dismiss}
      closeDisabled={create.isPending}
      title="添加项目"
      testId="add-project-dialog"
      footer={
        <>
          <Button onClick={dismiss} disabled={create.isPending} variant="outline">
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
      />
      <div className={hint}>输入目录名可递归搜索深层目录，或在文件树中浏览选择。</div>
      {error ? (
        <div className={errorMsg} role="alert" data-testid="add-project-error">
          {error}
        </div>
      ) : null}
    </Dialog>
  )
}

export type { AddProjectDialogProps }
