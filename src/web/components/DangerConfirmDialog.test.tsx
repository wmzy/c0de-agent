/**
 * DangerConfirmDialog 测试。
 * P2-6：永久不可逆操作的确认门——确认按钮必须在输入与 confirmWord
 * 逐字一致时才可用，防止肌肉记忆误删。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DangerConfirmDialog } from './DangerConfirmDialog.js'

afterEach(() => {
  cleanup()
})

function renderDialog(props?: Partial<{ confirmWord: string; confirmLabel: string }>) {
  const onConfirm = vi.fn()
  const onClose = vi.fn()
  render(
    <DangerConfirmDialog
      open={true}
      title="彻底删除会话"
      description="将彻底删除该会话。"
      confirmWord={props?.confirmWord ?? 'demo-session'}
      confirmLabel={props?.confirmLabel ?? '确认删除'}
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  )
  return { onConfirm, onClose }
}

describe('DangerConfirmDialog', () => {
  it('确认按钮在输入与 confirmWord 一致前保持禁用', () => {
    renderDialog()
    const input = screen.getByTestId('danger-confirm-input')
    const btn = screen.getByTestId('danger-confirm-btn') as HTMLButtonElement
    expect(btn.disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'demo-sessio' } })
    expect(btn.disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'demo-session' } })
    expect(btn.disabled).toBe(false)
  })

  it('输入不一致时点击不触发 onConfirm', () => {
    const { onConfirm } = renderDialog()
    fireEvent.change(screen.getByTestId('danger-confirm-input'), {
      target: { value: 'wrong' },
    })
    fireEvent.click(screen.getByTestId('danger-confirm-btn'))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('输入一致后点击触发 onConfirm', () => {
    const { onConfirm } = renderDialog()
    fireEvent.change(screen.getByTestId('danger-confirm-input'), {
      target: { value: 'demo-session' },
    })
    fireEvent.click(screen.getByTestId('danger-confirm-btn'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('取消按钮触发 onClose', () => {
    const { onClose } = renderDialog()
    fireEvent.click(screen.getByText('取消'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
