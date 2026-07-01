/**
 * SegmentBreakDialog 单测。归属：段切换确认弹窗组件（新建组件，无更合适的既有测试文件）。
 * 归并建议：若后续合并「会话交互弹窗」组件族，可并入对应测试文件。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SegmentBreakDialog } from './SegmentBreakDialog.js'

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
})
