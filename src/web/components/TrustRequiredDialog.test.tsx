/**
 * TrustRequiredDialog 单测。归属：P0-2 项目信任确认弹窗（新建组件）。
 * 归并建议：若后续合并「会话交互弹窗」组件族，可并入对应测试文件。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrustRequiredDialog } from '@/components/TrustRequiredDialog.js'

afterEach(cleanup)

describe('TrustRequiredDialog', () => {
  it('渲染项目名与全部风险项明细', () => {
    render(
      <TrustRequiredDialog
        projectName="Sneaky Repo"
        items={[
          { kind: 'permission-auto', detail: '权限模式 auto：工具将被自动放行' },
          { kind: 'plugins-enabled', detail: '启用项目插件：evil-plugin' },
        ]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByTestId('trust-required-dialog')).toBeTruthy()
    expect(screen.getByText(/Sneaky Repo/)).toBeTruthy()
    expect(screen.getByText(/权限模式 auto/)).toBeTruthy()
    expect(screen.getByText(/evil-plugin/)).toBeTruthy()
  })

  it('「信任并继续」触发 onConfirm', () => {
    const onConfirm = vi.fn()
    render(
      <TrustRequiredDialog
        projectName="Repo"
        items={[{ kind: 'permission-auto', detail: 'auto' }]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('trust-required-confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('「取消」触发 onCancel', () => {
    const onCancel = vi.fn()
    render(
      <TrustRequiredDialog
        projectName="Repo"
        items={[{ kind: 'plugins-enabled', detail: '插件' }]}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByTestId('trust-required-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  // 回归：信任失败的原因此前只写在会话区横幅上，而本弹窗是 <dialog> 模态——
  // 横幅被 ::backdrop 挡住，用户看到的是「点了信任并继续，弹窗纹丝不动」。
  it('信任失败原因渲染在弹窗内部（role=alert）', () => {
    render(
      <TrustRequiredDialog
        projectName="Repo"
        items={[{ kind: 'permission-auto', detail: 'auto' }]}
        error="信任项目失败：项目已被删除"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    const alert = screen.getByTestId('trust-required-error')
    expect(alert.textContent).toContain('信任项目失败：项目已被删除')
    expect(alert.getAttribute('role')).toBe('alert')
  })

  it('在飞（busy）时禁用两枚按钮并提示「信任中…」', () => {
    render(
      <TrustRequiredDialog
        projectName="Repo"
        items={[{ kind: 'permission-auto', detail: 'auto' }]}
        busy
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    const confirm = screen.getByTestId('trust-required-confirm') as HTMLButtonElement
    const cancel = screen.getByTestId('trust-required-cancel') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(cancel.disabled).toBe(true)
    expect(confirm.textContent).toContain('信任中')
  })
})
