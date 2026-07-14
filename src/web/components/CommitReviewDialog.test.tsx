import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommitReviewDialog } from './CommitReviewDialog.js'

afterEach(cleanup)

describe('CommitReviewDialog', () => {
  it('渲染所有可疑文件', () => {
    render(
      <CommitReviewDialog
        suggestions={['.env', 'dist/']}
        message="feat: x"
        onAppendIgnore={vi.fn()}
        onForce={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText('.env')).toBeInTheDocument()
    expect(screen.getByText('dist/')).toBeInTheDocument()
  })

  it('点击「加入 .gitignore 再提交」调用 onAppendIgnore', () => {
    const onAppendIgnore = vi.fn()
    render(
      <CommitReviewDialog
        suggestions={['.env']}
        message="feat: x"
        onAppendIgnore={onAppendIgnore}
        onForce={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('commit-review-ignore'))
    expect(onAppendIgnore).toHaveBeenCalledOnce()
  })

  it('点击「仍然提交」调用 onForce', () => {
    const onForce = vi.fn()
    render(
      <CommitReviewDialog
        suggestions={['.env']}
        message="feat: x"
        onAppendIgnore={vi.fn()}
        onForce={onForce}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('commit-review-force'))
    expect(onForce).toHaveBeenCalledOnce()
  })

  it('点击「取消」调用 onCancel', () => {
    const onCancel = vi.fn()
    render(
      <CommitReviewDialog
        suggestions={['.env']}
        message="feat: x"
        onAppendIgnore={vi.fn()}
        onForce={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByTestId('commit-review-cancel'))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
