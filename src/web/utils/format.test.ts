import { describe, expect, it } from 'vitest'
import {
  formatCost,
  formatLatency,
  formatTokenCount,
  parseCodeReference,
  parseFiniteNumber,
} from '@/utils/format.js'

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
  it('消息引用（UUID 形态 id）', () => {
    expect(parseCodeReference('@[0cac382d-ab59-478e-835e-d888a6460a0e:2]')).toEqual({
      _tag: 'message',
      messageId: '0cac382d-ab59-478e-835e-d888a6460a0e',
      blockIndex: 2,
    })
  })
  // 回归：无扩展名文件（README/Makefile/Dockerfile 等常见引用目标）此前按
  // 「不含点」被误判为消息引用——点击不跳转文件、渲染成消息标签。
  it('无扩展名文件路径的单行引用归类为文件', () => {
    expect(parseCodeReference('@[README:3]')).toEqual({
      _tag: 'file',
      path: 'README',
      startLine: 3,
      endLine: 3,
    })
    expect(parseCodeReference('@[src/Makefile:1]')).toEqual({
      _tag: 'file',
      path: 'src/Makefile',
      startLine: 1,
      endLine: 1,
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

describe('parseFiniteNumber', () => {
  it('常规数字原样解析', () => {
    expect(parseFiniteNumber('0.5', 1)).toBe(0.5)
    expect(parseFiniteNumber('-3', 1)).toBe(-3)
  })

  // 空串沿用 Number('') 语义 = 0：预算字段的「0 = 不限制」依赖清空即清零。
  it('空串按 0 解析', () => expect(parseFiniteNumber('', 7)).toBe(0))

  // 复现：'1e999' 是合法的浮点字面量但超出双精度 → Infinity；写进配置草稿后
  // JSON 序列化成 null，服务端按「取消该键」处理（预算护栏被静默删除）。
  it('溢出字面量（1e999）回落到当前值而非 Infinity', () => {
    expect(parseFiniteNumber('1e999', 0.8)).toBe(0.8)
    expect(parseFiniteNumber('-1e999', 5)).toBe(5)
  })

  it('非数字文本回落到当前值', () => {
    expect(parseFiniteNumber('abc', 3)).toBe(3)
    expect(parseFiniteNumber('1,000', 3)).toBe(3)
  })

  it('NaN 字面量回落到当前值', () => expect(parseFiniteNumber('NaN', 2)).toBe(2))
})
