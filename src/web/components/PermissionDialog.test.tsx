import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PermissionDialog } from './PermissionDialog.js'

describe('PermissionDialog', () => {
  afterEach(() => cleanup())

  it('显示工具名和输入', () => {
    render(
      <PermissionDialog tool="bash" input={{ cmd: 'ls' }} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(screen.getByText('bash')).toBeTruthy()
    expect(screen.getByTestId('permission-dialog')).toBeTruthy()
  })

  it('点击允许调用 onConfirm', () => {
    const onConfirm = vi.fn()
    render(<PermissionDialog tool="bash" input={{}} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByTestId('approve'))
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})
