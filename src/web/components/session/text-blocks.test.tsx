import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantTextBlock } from './AssistantTextBlock.js'
import { ReasoningBlock } from './ReasoningBlock.js'
import { UserTextBlock } from './UserTextBlock.js'

afterEach(() => cleanup())

describe('UserTextBlock', () => {
  it('渲染文本', () => {
    render(<UserTextBlock text="hello" />)
    expect(screen.getByTestId('user-text')).toHaveTextContent('hello')
  })
})

describe('AssistantTextBlock', () => {
  it('渲染内容并带复制按钮', () => {
    render(<AssistantTextBlock text="**bold**" />)
    expect(screen.getByTestId('assistant-text')).toBeInTheDocument()
    expect(screen.getByTestId('copy-button')).toBeInTheDocument()
  })

  it('有 completedAt 时显示时间', () => {
    render(<AssistantTextBlock text="hi" completedAt={1700000000000} />)
    expect(screen.getByTestId('assistant-time')).toBeInTheDocument()
  })
})

describe('ReasoningBlock', () => {
  it('默认折叠，点击展开', () => {
    render(<ReasoningBlock text="thinking" />)
    expect(screen.getByTestId('reasoning').getAttribute('data-expanded')).toBe('false')
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.getByTestId('reasoning').getAttribute('data-expanded')).toBe('true')
  })
})
