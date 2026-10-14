/**
 * SegmentBreakDialog 单测。归属：段切换确认弹窗组件（新建组件，无更合适的既有测试文件）。
 * 归并建议：若后续合并「会话交互弹窗」组件族，可并入对应测试文件。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SegmentBreakDialog } from '@/components/SegmentBreakDialog.js'

const activeSegment = { provider: 'openai', model: 'gpt-4', tools: ['read', 'edit'] }

afterEach(() => cleanup())

describe('SegmentBreakDialog', () => {
  it('渲染当前段信息（provider/model/工具数）', () => {
    render(
      <SegmentBreakDialog
        activeSegment={activeSegment}
        onConfirm={vi.fn()}
        onCompact={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    const text = screen.getByTestId('segment-break-dialog').textContent ?? ''
    expect(text).toContain('openai')
    expect(text).toContain('gpt-4')
    expect(text).toContain('2')
  })

  it('点击「继续」→ onConfirm', () => {
    const onConfirm = vi.fn()
    render(
      <SegmentBreakDialog
        activeSegment={activeSegment}
        onConfirm={onConfirm}
        onCompact={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('segment-break-confirm'))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('点击「顺便压缩会话」→ onCompact', () => {
    const onCompact = vi.fn()
    render(
      <SegmentBreakDialog
        activeSegment={activeSegment}
        onConfirm={vi.fn()}
        onCompact={onCompact}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('segment-break-compact'))
    expect(onCompact).toHaveBeenCalledOnce()
  })

  it('点击「取消」→ onCancel', () => {
    const onCancel = vi.fn()
    render(
      <SegmentBreakDialog
        activeSegment={activeSegment}
        onConfirm={vi.fn()}
        onCompact={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByTestId('segment-break-cancel'))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  /**
   * 缺陷：压缩请求在途时弹窗继续可交互，用户按「取消」看起来生效（弹窗关闭、
   * 界面恢复平静），压缩返回后 useChat 仍会 setState + doStream 把消息发出去；
   * 连点两次「顺便压缩会话」也会发两次 compact。
   */
  it('压缩在途时锁住三个选项与关闭通道（取消点击不生效）', async () => {
    let resolveCompact: () => void = () => {}
    const onCompact = vi.fn(() => new Promise<void>((resolve) => (resolveCompact = resolve)))
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(
      <SegmentBreakDialog
        activeSegment={activeSegment}
        onConfirm={onConfirm}
        onCompact={onCompact}
        onCancel={onCancel}
      />,
    )

    fireEvent.click(screen.getByTestId('segment-break-compact'))
    expect(onCompact).toHaveBeenCalledOnce()

    // 在途：三颗按钮 disabled、✕ 关闭键 disabled、文案变「压缩中…」
    expect(screen.getByTestId('segment-break-compact')).toBeDisabled()
    expect(screen.getByTestId('segment-break-confirm')).toBeDisabled()
    expect(screen.getByTestId('segment-break-cancel')).toBeDisabled()
    expect(screen.getByLabelText('关闭')).toBeDisabled()
    expect(screen.getByTestId('segment-break-compact').textContent).toContain('压缩中')

    // 连点第二次不得再发一次 compact；取消按钮点了也不得调用 onCancel
    fireEvent.click(screen.getByTestId('segment-break-compact'))
    fireEvent.click(screen.getByTestId('segment-break-cancel'))
    expect(onCompact).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()

    await act(async () => {
      resolveCompact()
      await Promise.resolve()
    })

    // 落地后解锁（真实调用点上此刻 pendingSegmentBreak 已清空、弹窗已卸载）
    expect(screen.getByTestId('segment-break-compact')).not.toBeDisabled()
    expect(screen.getByTestId('segment-break-confirm')).not.toBeDisabled()
    expect(screen.getByTestId('segment-break-compact').textContent).toContain('顺便压缩')
  })
})
