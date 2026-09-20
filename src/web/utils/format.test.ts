import { describe, expect, it } from 'vitest'
import { formatCost, formatLatency, formatTokenCount, parseCodeReference } from '@/utils/format.js'

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

  // 二进制浮点舍入回归：toFixed 直接作用于二进制近似值时 half-up 舍入会
  // 系统性下偏——1.005/0.015/2.675 均少一分钱（显示 $1.00/$0.01/$2.67）。
  it('1.005 舍入为 $1.01 而非 $1.00', () => expect(formatCost(1.005)).toBe('$1.01'))
  it('0.015 舍入为 $0.02 而非 $0.01', () => expect(formatCost(0.015)).toBe('$0.02'))
  it('2.675 舍入为 $2.68 而非 $2.67', () => expect(formatCost(2.675)).toBe('$2.68'))
  it('极小额同样按十进制舍入', () => expect(formatCost(0.0045)).toBe('$0.0045'))
  it('大于阈值的边界不误入极小额分支', () => expect(formatCost(0.01)).toBe('$0.01'))
})
