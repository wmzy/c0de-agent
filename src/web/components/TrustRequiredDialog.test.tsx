/**
 * TrustRequiredDialog 单测。归属：P0-2 项目信任确认弹窗（新建组件）。
 * 归并建议：若后续合并「会话交互弹窗」组件族，可并入对应测试文件。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrustRequiredDialog } from './TrustRequiredDialog.js'

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
})
