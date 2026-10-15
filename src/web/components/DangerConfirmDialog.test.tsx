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

  /**
   * 调用点常把本组件常驻挂载、只切 open（WorkflowsPanel 的 pendingDelete、
   * UpdateBanner 的 confirmOpen），typed 因此跨关闭保留：用户认真输过一次确认
   * 词、按 Esc 后悔，重开时输入框里还留着上一次的词，确认键第一帧即可按下——
   * 逐字确认这道门禁第二次打开就失效了。
   */
  it('常驻挂载下重新打开时确认词被清空，确认键重新禁用', () => {
    const { rerender } = render(
      <DangerConfirmDialog
        open={true}
        title="删除工作流 demo"
        description="工作流文件将被永久删除。"
        confirmWord="demo"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.change(screen.getByTestId('danger-confirm-input'), { target: { value: 'demo' } })
    expect((screen.getByTestId('danger-confirm-btn') as HTMLButtonElement).disabled).toBe(false)

    rerender(
      <DangerConfirmDialog
        open={false}
        title="删除工作流 demo"
        description="工作流文件将被永久删除。"
        confirmWord="demo"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    )
    rerender(
      <DangerConfirmDialog
        open={true}
        title="删除工作流 demo"
        description="工作流文件将被永久删除。"
        confirmWord="demo"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    )

    expect((screen.getByTestId('danger-confirm-input') as HTMLInputElement).value).toBe('')
    expect((screen.getByTestId('danger-confirm-btn') as HTMLButtonElement).disabled).toBe(true)
  })

  /**
   * 失败原因只渲染在这块面板里（role=alert）。请求在飞时按下 Esc / 点背景 /
   * 取消把面板关掉，随后到达的失败就无处可报——浏览器实测：删除项目时按 Esc，
   * 服务端 500 后整页没有任何提示，用户看到的是「点了删除，什么也没发生」。
   */
  it('busy 期间不响应 Esc、关闭键与取消，失败原因留在面板里', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <DangerConfirmDialog
        open={true}
        title="删除项目"
        description="将删除项目。"
        confirmWord="demo"
        busy={true}
        onConfirm={() => {}}
        onClose={onClose}
      />,
    )

    fireEvent.keyDown(document.querySelector('dialog') as HTMLElement, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    fireEvent.click(screen.getByText('取消'))
    expect(onClose).not.toHaveBeenCalled()

    rerender(
      <DangerConfirmDialog
        open={true}
        title="删除项目"
        description="将删除项目。"
        confirmWord="demo"
        busy={true}
        error="项目下有 1 个打开的终端"
        onConfirm={() => {}}
        onClose={onClose}
      />,
    )
    expect(screen.getByTestId('danger-error').textContent).toContain('打开的终端')

    rerender(
      <DangerConfirmDialog
        open={true}
        title="删除项目"
        description="将删除项目。"
        confirmWord="demo"
        busy={false}
        error="项目下有 1 个打开的终端"
        onConfirm={() => {}}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByText('取消'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  /**
   * 次级动作（「导出看板并删除」）在飞时，弹层也必须锁住。它在落地后会接着执行
   * 确认动作本身——期间按 Esc/取消只是看着取消了：导出返回后项目与看板照样被
   * 永久删除，用户以为拦下了。次级按钮自己的 disabled 挡不住弹层这扇门。
   */
  it('次级动作在飞期间不响应 Esc、关闭键与取消，也不放行确认键', () => {
    const onClose = vi.fn()
    const onSecondary = vi.fn()
    render(
      <DangerConfirmDialog
        open={true}
        title="删除项目"
        description="将删除项目。"
        confirmWord="demo"
        busy={false}
        secondaryAction={{ label: '导出看板并删除', onClick: onSecondary, busy: true }}
        onConfirm={() => {}}
        onClose={onClose}
      />,
    )

    fireEvent.keyDown(document.querySelector('dialog') as HTMLElement, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    fireEvent.click(screen.getByText('取消'))
    expect(onClose).not.toHaveBeenCalled()

    // 确认键同样锁住：导出在飞时再点一次删除会与导出后的删除并发
    fireEvent.change(screen.getByTestId('danger-confirm-input'), { target: { value: 'demo' } })
    expect((screen.getByTestId('danger-confirm-btn') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('danger-secondary-btn') as HTMLButtonElement).textContent).toBe(
      '处理中…',
    )
  })

  it('次级动作空闲时弹层可正常关闭并放行确认键', () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    render(
      <DangerConfirmDialog
        open={true}
        title="删除项目"
        description="将删除项目。"
        confirmWord="demo"
        secondaryAction={{ label: '导出看板并删除', onClick: () => {}, busy: false }}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByText('取消'))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByTestId('danger-confirm-input'), { target: { value: 'demo' } })
    fireEvent.click(screen.getByTestId('danger-confirm-btn'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
