/**
 * DangerConfirmDialog 测试。
 * P2-6：永久不可逆操作的确认门——确认按钮必须在输入与 confirmWord
 * 逐字一致时才可用，防止肌肉记忆误删。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DangerConfirmDialog } from '@/components/DangerConfirmDialog.js'

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

  // 删除项目失败时弹层继续显示（不再先关闭自己），原因必须与用户正在做的
  // 操作同框可见并被读屏播报——此前原因写在项目下拉里，下拉已关闭卸载。
  it('失败原因在弹层内可见并带 role=alert', () => {
    render(
      <DangerConfirmDialog
        open={true}
        title="删除项目"
        description="将删除项目。"
        confirmWord="demo"
        error="项目下有 1 个打开的终端，请先关闭终端后再删除项目"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    )
    const alert = screen.getByTestId('danger-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain('打开的终端')
  })

  it('未失败时不渲染错误条', () => {
    renderDialog()
    expect(screen.queryByTestId('danger-error')).toBeNull()
  })
})
