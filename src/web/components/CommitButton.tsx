import { css } from '@linaria/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Tooltip } from 'haze-ui'
import { useState } from 'react'
import { CommitReviewDialog } from '@/components/CommitReviewDialog.js'
import { fileAPI } from '@/services/file.js'
import { btnSm } from '@/styles/tokens.js'

const commitBtn = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
  &:hover:not(:disabled) {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-primary);
  }
  &:focus {
    outline: none;
    border-color: var(--haze-color-primary);
  }
  &:disabled {
    color: var(--haze-color-text-muted);
    background: var(--haze-color-bg-muted);
    cursor: not-allowed;
  }
`

const commitBtnActive = css`
  background: var(--haze-color-primary);
  border-color: var(--haze-color-primary);
  /* 实底上的前景色走 token 而非 #fff：primary 的 dark 值是为深底上的蓝**字**
     调的，当底色时白字仅 3.00:1（实测 axe color-contrast serious，12px
     文字需 4.5）——这是项目页最常点的按钮，偏偏最看不清。 */
  color: var(--c0de-primary-on-solid, #fff);
  font-weight: 600;
  /*
   * 「有未提交变更」的呼吸提示改用 box-shadow 外扩光晕，不再整体降 opacity。
   * 原来 0.85→1 的 opacity 脉动会把整块实底连同文字一起变淡：暗色主题下
   * 合成底实测 3.75:1（满不透明时 4.87），恰好在呼吸谷底跌破 AA 4.5——
   * 一个「吸引注意」的动画让按钮周期性变得不可读。box-shadow 画在按钮
   * 外侧，不参与文字/底色的合成，视觉注意力效果保留，对比度不再波动。
   */
  animation: pulseRing 2s ease-in-out infinite;
  /*
   * 悬停态：换一档**同色系**的实底（--c0de-primary-hover-solid），不用
   * --haze-color-primary-hover——后者对实底场景是反的（暗色下更暗，把前景
   * 压到 4.07 / 3.58），也不必退回全局按钮的中性灰底（浅灰底 + 主色字
   * 实测 2.07:1）。
   *
   * 选择器必须与 global.ts 的裸按钮悬停规则同特异度
   * （:where(button):hover:not(:disabled):not([aria-disabled]) = 0,3,0）——
   * 单写 :hover 只有 0,2,0，会被那条全局规则直接覆盖：实测鼠标一移入，
   * 底色变成浅灰、文字变回主色，对比度 2.07。两条同特异度时按源序，本
   * 组件晚于 global.ts 求值，故本规则生效。
   *
   * 也必须写在 animation 之后：同名 box-shadow 会被动画关键帧逐帧覆盖
   * （animation 优先级高于普通声明），写在前会被吃掉。
   */
  &:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--c0de-primary-hover-solid);
    border-color: var(--c0de-primary-hover-solid);
    color: var(--c0de-primary-on-solid, #fff);
    animation: hoverRing 0.15s ease-out forwards;
  }
  @keyframes pulseRing {
    0%,
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--haze-color-primary) 45%, transparent);
    }
    50% {
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--haze-color-primary) 0%, transparent);
    }
  }
  @keyframes hoverRing {
    from {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--haze-color-primary) 45%, transparent);
    }
    to {
      box-shadow: 0 0 0 6px color-mix(in srgb, var(--haze-color-primary) 25%, transparent);
    }
  }
`

const commitBtnSuccess = css`
  background: var(--haze-color-success);
  border-color: var(--haze-color-success);
  /* 同 commitBtnActive：success 的 dark 值是为深底上的绿字调的，当实底时
     白字仅 2.28:1（实测），是本文件三态里最差的一处。 */
  color: var(--c0de-success-on-solid, #fff);
  /* 反馈期间按钮已禁用（提交后无变更），重申语义色避免被全局禁用灰态覆盖 */
  &:disabled {
    background: var(--haze-color-success);
    border-color: var(--haze-color-success);
    color: var(--c0de-success-on-solid, #fff);
  }
`

const commitBtnError = css`
  background: var(--haze-color-danger);
  border-color: var(--haze-color-danger);
  color: var(--c0de-danger-on-solid, #fff);
  /* 反馈期间按钮可能禁用（无变更），重申语义色避免被全局禁用灰态覆盖 */
  &:disabled {
    background: var(--haze-color-danger);
    border-color: var(--haze-color-danger);
    color: var(--c0de-danger-on-solid, #fff);
  }
`

/**
 * 一键提交按钮：有变更时高亮，点击调用便宜模型生成 commit message 并提交。
 * 放置在 TopBar 的 ProjectIndicator actions 槽。
 * git status 查询与 FileBrowser 共享同一 queryKey，React Query 自动去重缓存；
 * 提交成功后 invalidate 触发双方刷新。
 */
export function CommitButton({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()

  const gitStatusQ = useQuery({
    queryKey: ['files', 'git-status', projectId],
    queryFn: () => fileAPI.gitStatus(projectId),
    refetchInterval: 30_000,
  })

  const hasChanges =
    !!gitStatusQ.data && Object.values(gitStatusQ.data).some((c) => c !== 'ignored')
  // 读不到 git status（接口 5xx / 项目已删除 404）与「确实没有变更」是两回事：
  // 此前两者共用 hasChanges=false，按钮被禁用且 title 写死「无变更」——用户明明有
  // 未提交改动，看到的却是一句肯定没有变更的谎话，且唯一的提交入口还是灰的，
  // 30s 轮询之外没有任何重试手段。本仓 TodoPanel/ArchivePanel/UsagePanel/
  // FileBrowser 都已按「拉不到≠没有」修过同类，这里补齐：失败态下按钮可点、
  // 点了重试读取，文案如实说明读不到。
  const gitStatusFailed = gitStatusQ.isError && !gitStatusQ.data

  const [commitFeedback, setCommitFeedback] = useState<
    { kind: 'idle' } | { kind: 'ok'; message: string } | { kind: 'err'; msg: string }
  >({ kind: 'idle' })

  // LLM 检测到可疑文件时展示审查弹框
  const [reviewState, setReviewState] = useState<{
    message: string
    suggestions: string[]
  } | null>(null)

  const commitMut = useMutation({
    mutationFn: (body?: { mode?: string; message?: string; suggestions?: string[] }) =>
      fileAPI.gitCommit(projectId, body),
    onMutate: () => setCommitFeedback({ kind: 'idle' }),
    onSuccess: (data) => {
      // 需要审查 → 弹框，不显示成功
      if ('needsReview' in data && data.needsReview) {
        setReviewState({ message: data.message, suggestions: data.suggestions })
        return
      }
      // 提交成功 → 关弹框（若有）、显示成功、刷新状态
      setReviewState(null)
      setCommitFeedback({ kind: 'ok', message: data.message })
      queryClient.invalidateQueries({ queryKey: ['files', 'git-status', projectId] })
      setTimeout(() => setCommitFeedback((s) => (s.kind === 'ok' ? { kind: 'idle' } : s)), 3000)
    },
    onError: (err: unknown) => {
      const msg =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: string }).message)
          : '提交失败'
      setCommitFeedback({ kind: 'err', msg })
      setTimeout(() => setCommitFeedback((s) => (s.kind === 'err' ? { kind: 'idle' } : s)), 5000)
    },
  })

  const btnClass = (() => {
    const base = `${btnSm} ${commitBtn}`
    if (commitMut.isPending) return base
    if (commitFeedback.kind === 'ok') return `${base} ${commitBtnSuccess}`
    if (commitFeedback.kind === 'err') return `${base} ${commitBtnError}`
    if (hasChanges) return `${base} ${commitBtnActive}`
    return base
  })()

  const label = (() => {
    if (commitMut.isPending) return '提交中…'
    if (commitFeedback.kind === 'ok') return '✓ 已提交'
    if (commitFeedback.kind === 'err') return '提交失败'
    return '提交'
  })()

  const title = (() => {
    if (commitFeedback.kind === 'ok') return commitFeedback.message
    if (commitFeedback.kind === 'err') return commitFeedback.msg
    if (gitStatusFailed) return '无法读取 git 状态（点击重试）'
    return hasChanges ? 'AI 生成 commit message 并提交全部变更' : '无变更'
  })()

  return (
    <>
      <Tooltip content={title}>
        <button
          type="button"
          className={btnClass}
          // 失败态下点击是「重试读取」而非提交：没有 git 状态就无从判断要提交什么，
          // 直接提交会把「读不到」当成「没有变更」的空提交送出去。
          onClick={() =>
            gitStatusFailed ? void gitStatusQ.refetch() : commitMut.mutate(undefined)
          }
          disabled={commitMut.isPending || (!hasChanges && !gitStatusFailed)}
          data-testid="git-commit-btn"
          data-has-changes={hasChanges || undefined}
          data-git-status-failed={gitStatusFailed || undefined}
        >
          {label}
        </button>
      </Tooltip>
      {reviewState && (
        <CommitReviewDialog
          suggestions={reviewState.suggestions}
          message={reviewState.message}
          onAppendIgnore={() =>
            commitMut.mutate({
              mode: 'append-ignore',
              message: reviewState.message,
              suggestions: reviewState.suggestions,
            })
          }
          onForce={() => commitMut.mutate({ mode: 'force', message: reviewState.message })}
          onCancel={() => setReviewState(null)}
        />
      )}
    </>
  )
}
