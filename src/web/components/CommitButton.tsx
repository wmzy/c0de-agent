import { css } from '@linaria/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { fileAPI } from '../services/file.js'
import { CommitReviewDialog } from './CommitReviewDialog.js'

const commitBtn = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
  min-height: auto;
  min-width: auto;
  &:hover {
    border-color: var(--primary);
    color: var(--primary);
  }
  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`

const commitBtnActive = css`
  background: var(--warning);
  border-color: var(--warning);
  color: #fff;
  font-weight: 600;
  animation: pulse 2s ease-in-out infinite;
  &:hover {
    background: var(--warning);
    color: #fff;
    opacity: 0.9;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.85;
    }
  }
`

const commitBtnSuccess = css`
  background: var(--success);
  border-color: var(--success);
  color: #fff;
`

const commitBtnError = css`
  background: var(--error);
  border-color: var(--error);
  color: #fff;
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
    if (commitMut.isPending) return commitBtn
    if (commitFeedback.kind === 'ok') return `${commitBtn} ${commitBtnSuccess}`
    if (commitFeedback.kind === 'err') return `${commitBtn} ${commitBtnError}`
    if (hasChanges) return `${commitBtn} ${commitBtnActive}`
    return commitBtn
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
    return hasChanges ? 'AI 生成 commit message 并提交全部变更' : '无变更'
  })()

  return (
    <>
      <button
        type="button"
        className={btnClass}
        onClick={() => commitMut.mutate()}
        disabled={commitMut.isPending || !hasChanges}
        title={title}
        data-testid="git-commit-btn"
        data-has-changes={hasChanges || undefined}
      >
        {label}
      </button>
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
