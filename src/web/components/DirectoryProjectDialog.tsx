import { css } from '@linaria/core'
import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from 'haze-ui'
import { useState } from 'react'
import { Dialog } from '@/components/Dialog.js'
import { DirectoryPicker } from '@/components/DirectoryPicker.js'
import { messageOf } from '@/utils/errors.js'

const hintStyle = css`
  font-size: 12px;
  color: var(--haze-color-text-secondary);
`

const errorStyle = css`
  font-size: 12px;
  color: var(--haze-color-danger);
`

export type DirectoryProjectDialogProps<T> = {
  /** Dialog 标题。 */
  title: string
  /** 目录输入下方的说明文案。 */
  hint: string
  /** 目录输入的占位符。 */
  placeholder: string
  /** testid 前缀（`${testId}-dialog/-input/-confirm/-error`）。 */
  testId: string
  /** 请求在飞时确认键的文案。 */
  pendingLabel: string
  /** 确认键文案（非在飞态）。 */
  confirmLabel: string
  /** 目录路径 → 请求（创建/迁移项目）。 */
  mutationFn: (dir: string) => Promise<T>
  /** 成功后失效的 query key 列表（项目列表/当前项目指示器/会话等）。 */
  invalidations: QueryKey[]
  /** 成功回调（收到 mutationFn 的结果；回调后弹窗统一 onClose）。 */
  onSuccess: (result: T) => void
  onClose: () => void
}

/**
 * 「输入目录路径操作项目」弹窗骨架（添加项目 / 重新定位项目共用）：
 * DirectoryPicker + 回车提交 + 在飞禁关/防重复提交 + 面板内错误展示。
 * 两个弹窗仅标题、文案、mutation 与失效范围不同。
 */
export function DirectoryProjectDialog<T>({
  title,
  hint,
  placeholder,
  testId,
  pendingLabel,
  confirmLabel,
  mutationFn,
  invalidations,
  onSuccess,
  onClose,
}: DirectoryProjectDialogProps<T>) {
  const qc = useQueryClient()
  const [directory, setDirectory] = useState('')
  const [error, setError] = useState<string | null>(null)

  const run = useMutation({
    mutationFn,
    onSuccess: (result) => {
      for (const queryKey of invalidations) qc.invalidateQueries({ queryKey })
      onSuccess(result)
      onClose()
    },
    onError: (err: unknown) => {
      // APIError 是真正的 Error（services/api.ts）；取文案统一走 messageOf
      // （结构化 message → Error.message → String 兜底）。
      setError(messageOf(err))
    },
  })

  const submit = () => {
    // 去掉尾部斜杠后提交
    const dir = directory.trim().replace(/\/+$/, '')
    if (!dir) return
    // 在飞时回车/再点确认会排第二次 mutate（重复建项目/迁移），一并挡掉。
    if (run.isPending) return
    setError(null)
    run.mutate(dir)
  }

  // 请求在飞时不给关闭的出口：Esc / 点背景 / ✕ / 取消都走这里。失败原因只渲染
  // 在这块面板里，中途关掉它就等于把失败原因一起关掉——实测目录建项目时按 Esc，
  // 服务端随后 500，用户看到的是「点了添加，什么也没发生」，项目也没建出来。
  const dismiss = () => {
    if (run.isPending) return
    onClose()
  }

  return (
    <Dialog
      onClose={dismiss}
      closeDisabled={run.isPending}
      title={title}
      testId={`${testId}-dialog`}
      footer={
        <>
          <Button onClick={dismiss} disabled={run.isPending} variant="outline">
            取消
          </Button>
          <Button
            onClick={submit}
            disabled={!directory.trim() || run.isPending}
            data-testid={`${testId}-confirm`}
            variant="outline"
          >
            {run.isPending ? pendingLabel : confirmLabel}
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
        placeholder={placeholder}
        testId={`${testId}-input`}
      />
      <div className={hintStyle}>{hint}</div>
      {error ? (
        <div className={errorStyle} role="alert" data-testid={`${testId}-error`}>
          {error}
        </div>
      ) : null}
    </Dialog>
  )
}
