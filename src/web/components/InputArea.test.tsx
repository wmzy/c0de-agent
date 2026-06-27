import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { InputArea } from './InputArea.js'

afterEach(() => cleanup())

describe('InputArea', () => {
  it('输入后点发送回调', () => {
    const onSend = vi.fn()
    render(<InputArea onSend={onSend} />)
    fireEvent.change(screen.getByTestId('input'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByTestId('send'))
    expect(onSend).toHaveBeenCalledWith('hello')
  })

  it('空文本不发送', () => {
    const onSend = vi.fn()
    render(<InputArea onSend={onSend} />)
    fireEvent.click(screen.getByTestId('send'))
    expect(onSend).not.toHaveBeenCalled()
  })

  it('Enter 发送，Shift+Enter 不', () => {
    const onSend = vi.fn()
    render(<InputArea onSend={onSend} />)
    fireEvent.change(screen.getByTestId('input'), { target: { value: 'x' } })
    fireEvent.keyDown(screen.getByTestId('input'), { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByTestId('input'), { key: 'Enter' })
    expect(onSend).toHaveBeenCalled()
  })

  it('/ 显示 slash 菜单', () => {
    render(<InputArea onSend={vi.fn()} />)
    fireEvent.change(screen.getByTestId('input'), { target: { value: '/' } })
    expect(screen.getByTestId('slash-menu')).toBeTruthy()
  })
})
