import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommitReviewDialog } from '@/components/CommitReviewDialog.js'

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

  // 复现：提交失败时原因只落在顶栏按钮上，位于 <dialog>::backdrop 之后、
  // 读屏也被 inert 挡住——用户在模态框里看到的只有「点了没反应」。
  it('失败原因渲染在弹窗内并被读屏播报', () => {
    render(
      <CommitReviewDialog
        suggestions={['.env']}
        message="feat: x"
        error="pre-commit hook 拒绝了这次提交"
        onAppendIgnore={vi.fn()}
        onForce={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('pre-commit hook 拒绝了这次提交')
  })

  // 复现：三颗按钮在请求在飞时恒可点，连点「仍然提交」会排第二次 git commit。
  it('提交在飞时按钮禁用、取消不再关闭弹窗', () => {
    const onForce = vi.fn()
    const onCancel = vi.fn()
    render(
      <CommitReviewDialog
        suggestions={['.env']}
        message="feat: x"
        busy
        onAppendIgnore={vi.fn()}
        onForce={onForce}
        onCancel={onCancel}
      />,
    )
    for (const id of ['commit-review-cancel', 'commit-review-force', 'commit-review-ignore']) {
      fireEvent.click(screen.getByTestId(id))
    }
    expect(onForce).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })
})
