import { describe, expect, it } from 'vitest'
import { formatCost, formatLatency, formatTokenCount, parseCodeReference } from './format.js'

describe('parseCodeReference', () => {
  it('文件引用单行', () => {
    expect(parseCodeReference('@[src/main.ts:10]')).toEqual({
      _tag: 'file',
      path: 'src/main.ts',
      startLine: 10,
      endLine: 10,
    })
  })
  it('文件引用区间', () => {
    expect(parseCodeReference('@[src/a.ts:5-12]')).toEqual({
      _tag: 'file',
      path: 'src/a.ts',
      startLine: 5,
      endLine: 12,
    })
  })
  it('消息引用', () => {
    expect(parseCodeReference('@[msg_abc:2]')).toEqual({
      _tag: 'message',
      messageId: 'msg_abc',
      blockIndex: 2,
    })
  })
  it('非法返回 null', () => {
    expect(parseCodeReference('hello')).toBeNull()
  })
})

describe('formatTokenCount', () => {
  it('小于 1000 原值', () => expect(formatTokenCount(500)).toBe('500'))
  it('k 单位', () => expect(formatTokenCount(1500)).toBe('1.5k'))
})

describe('formatLatency', () => {
  it('ms', () => expect(formatLatency(500)).toBe('500ms'))
  it('s', () => expect(formatLatency(1500)).toBe('1.50s'))
})

describe('formatCost', () => {
  it('零花费', () => expect(formatCost(0)).toBe('$0'))
  it('极小额保留 4 位小数', () => expect(formatCost(0.001)).toBe('$0.0010'))
  it('常规保留 2 位小数', () => expect(formatCost(1.234)).toBe('$1.23'))
})
