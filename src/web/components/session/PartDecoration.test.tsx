import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PartDecoration } from './PartDecoration.js'
import type { RenderBlock } from './utils/normalizeParts.js'

afterEach(() => cleanup())

describe('PartDecoration', () => {
  it('user text 显示用户 icon', () => {
    const block: RenderBlock = { type: 'text', role: 'user', text: 'hi', partIndex: 0 }
    render(<PartDecoration block={block} />)
    expect(screen.getByTestId('decoration').getAttribute('data-icon')).toBe('user')
  })

  it('assistant text 显示 sparkle icon', () => {
    const block: RenderBlock = { type: 'text', role: 'assistant', text: 'hi', partIndex: 0 }
    render(<PartDecoration block={block} />)
    expect(screen.getByTestId('decoration').getAttribute('data-icon')).toBe('assistant')
  })

  it('thinking 显示 brain icon', () => {
    const block: RenderBlock = { type: 'thinking', text: 'hmm', partIndex: 0 }
    render(<PartDecoration block={block} />)
    expect(screen.getByTestId('decoration').getAttribute('data-icon')).toBe('brain')
  })

  it('tool 块按工具名显示对应 icon', () => {
    const block: RenderBlock = {
      type: 'tool',
      id: '1',
      tool: 'bash',
      input: {},
      status: 'completed',
    }
    render(<PartDecoration block={block} />)
    expect(screen.getByTestId('decoration').getAttribute('data-icon')).toBe('bash')
  })

  it('未知工具显示通用 tool icon', () => {
    const block: RenderBlock = {
      type: 'tool',
      id: '1',
      tool: 'custom',
      input: {},
      status: 'running',
    }
    render(<PartDecoration block={block} />)
    expect(screen.getByTestId('decoration').getAttribute('data-icon')).toBe('tool')
  })
})
