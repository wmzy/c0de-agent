import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShakeRegionView } from '../types/index.js'
import { ShakePanel } from './ShakePanel.js'

afterEach(cleanup)

const regions: ShakeRegionView[] = [
  {
    id: 'msg1:toolResult:0',
    kind: 'toolResult',
    messageId: 'msg1',
    messageIndex: 0,
    tokens: 800,
    label: 'bash',
    preview: 'huge output...',
    placeholder: '[shaken: bash, 800 tokens]',
    isAfterProtectWindow: true,
  },
  {
    id: 'msg2:block:0:10',
    kind: 'block',
    messageId: 'msg2',
    messageIndex: 1,
    tokens: 500,
    label: 'assistant',
    preview: '```ts\n...',
    placeholder: '[shaken]',
    isAfterProtectWindow: false,
  },
]

describe('ShakePanel', () => {
  it('渲染 region 列表', () => {
    render(<ShakePanel regions={regions} onSubmit={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByTestId('shake-region-msg1:toolResult:0')).toBeTruthy()
    expect(screen.getByTestId('shake-region-msg2:block:0:10')).toBeTruthy()
  })

  it('默认勾选 isAfterProtectWindow=true 的 region', () => {
    render(<ShakePanel regions={regions} onSubmit={vi.fn()} onClose={vi.fn()} />)
    const checkbox1 = screen.getByTestId('shake-region-msg1:toolResult:0').querySelector('input')
    const checkbox2 = screen.getByTestId('shake-region-msg2:block:0:10').querySelector('input')
    expect(checkbox1?.checked).toBe(true)
    expect(checkbox2?.checked).toBe(false)
  })

  it('全选按钮选中所有 region', () => {
    render(<ShakePanel regions={regions} onSubmit={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('shake-select-all'))
    const checkbox2 = screen.getByTestId('shake-region-msg2:block:0:10').querySelector('input')
    expect(checkbox2?.checked).toBe(true)
  })

  it('取消全选清除所有勾选', () => {
    render(<ShakePanel regions={regions} onSubmit={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('shake-select-all'))
    fireEvent.click(screen.getByTestId('shake-deselect-all'))
    const checkbox1 = screen.getByTestId('shake-region-msg1:toolResult:0').querySelector('input')
    expect(checkbox1?.checked).toBe(false)
  })

  it('选当前及以下：勾选 messageIndex >= 1 的 region', () => {
    render(<ShakePanel regions={regions} fromIndex={1} onSubmit={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('shake-select-from-here'))
    const checkbox1 = screen.getByTestId('shake-region-msg1:toolResult:0').querySelector('input')
    const checkbox2 = screen.getByTestId('shake-region-msg2:block:0:10').querySelector('input')
    expect(checkbox1?.checked).toBe(false)
    expect(checkbox2?.checked).toBe(true)
  })

  it('提交时传入选中的 regionIds', () => {
    const onSubmit = vi.fn()
    render(<ShakePanel regions={regions} onSubmit={onSubmit} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('shake-submit'))
    expect(onSubmit).toHaveBeenCalledWith(['msg1:toolResult:0'])
  })

  it('取消按钮调用 onClose', () => {
    const onClose = vi.fn()
    render(<ShakePanel regions={regions} onSubmit={vi.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('shake-cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('无 region 时显示空状态', () => {
    render(<ShakePanel regions={[]} onSubmit={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByTestId('shake-empty')).toBeTruthy()
  })

  it('点击 region 行切换勾选', () => {
    render(<ShakePanel regions={regions} onSubmit={vi.fn()} onClose={vi.fn()} />)
    const checkbox2 = screen.getByTestId('shake-region-msg2:block:0:10').querySelector('input')
    expect(checkbox2?.checked).toBe(false)
    fireEvent.click(screen.getByTestId('shake-region-msg2:block:0:10'))
    expect(checkbox2?.checked).toBe(true)
  })
})
