// Dialog 焦点归还回归，对应 src/web/components/Dialog.tsx。
//
// 缺陷：面板是原生 <dialog>，打开即把焦点收进面板；Esc 被 haze 的 onCancel
// preventDefault 掉走受控关闭，浏览器「close 时归还 showModal 前焦点」永不触发。
// 关闭后焦点停在 <body>，键盘用户丢失位置（下次 Tab 从页首重来），读屏丢失上下文。
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dialog } from '@/components/Dialog.js'

afterEach(cleanup)

/** 会话页面板的真实形态：触发按钮常驻，Dialog 条件挂载。 */
function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开归档
      </button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title="会话归档">
          <p>面板内容</p>
        </Dialog>
      )}
    </>
  )
}

describe('Dialog — 关闭后焦点归还', () => {
  it('关闭后焦点回到打开面板的按钮', () => {
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: '打开归档' })
    trigger.focus()

    fireEvent.click(trigger)
    // 面板打开时焦点已被原生 showModal 收进面板内
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('触发元素随关闭一并离开文档时不对它调 focus', () => {
    // 会话树删除确认：确认后会话行与确认面板同时消失，触发按钮不再存在。
    function SelfRemovingTriggerHarness() {
      const [row, setRow] = useState(true)
      const [open, setOpen] = useState(false)
      return (
        <>
          {row && (
            <button type="button" onClick={() => setOpen(true)}>
              删除会话
            </button>
          )}
          {open && (
            <Dialog
              open
              onClose={() => {
                setOpen(false)
                setRow(false)
              }}
              title="删除会话"
            >
              <p>该会话将移入回收站。</p>
            </Dialog>
          )}
        </>
      )
    }
    render(<SelfRemovingTriggerHarness />)
    const trigger = screen.getByRole('button', { name: '删除会话' })
    const focusSpy = vi.spyOn(trigger, 'focus')
    fireEvent.click(trigger)

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger.isConnected).toBe(false)
    // 对已脱离文档的节点 focus() 是空操作，白调一次还挡掉了后续正确归还。
    expect(focusSpy).not.toHaveBeenCalled()
  })

  it('宿主 close 时已把焦点交给别的控件，不与之抢焦点', () => {
    function TakeoverHarness() {
      const [open, setOpen] = useState(false)
      const [field, setField] = useState<HTMLInputElement | null>(null)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开
          </button>
          <input aria-label="名称" ref={setField} />
          {open && (
            <Dialog
              open
              onClose={() => {
                setOpen(false)
                // 宿主显式把焦点交给面板后的第一个字段
                field?.focus()
              }}
              title="面板"
            >
              <p>内容</p>
            </Dialog>
          )}
        </>
      )
    }
    render(<TakeoverHarness />)
    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))

    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '名称' }))
  })
})
