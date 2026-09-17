import { describe, expect, it } from 'vitest'
import {
  monthTokenSum,
  resolveEffectiveBudget,
  resolveEffectiveTokenBudget,
} from '@/utils/usage.js'

describe('monthTokenSum', () => {
  it('input + output + cacheRead 三者求和', () => {
    expect(monthTokenSum({ inputTokens: 10, outputTokens: 20, cacheRead: 5 })).toBe(35)
  })
  it('缺省字段按 0 计', () => {
    expect(monthTokenSum({ inputTokens: 10 })).toBe(10)
    expect(monthTokenSum(undefined)).toBe(0)
    expect(monthTokenSum(null)).toBe(0)
  })
})

describe('resolveEffectiveBudget', () => {
  it('项目视图取项目预算', () => {
    expect(resolveEffectiveBudget('p1', 50, 100)).toBe(50)
  })
  it('全局视图取全局预算', () => {
    expect(resolveEffectiveBudget(undefined, 50, 100)).toBe(100)
  })
  it('全局视图不回退到项目预算（口径与服务端 budgetOverageParts 一致）', () => {
    expect(resolveEffectiveBudget(undefined, 50, undefined)).toBe(0)
  })
})

describe('resolveEffectiveTokenBudget', () => {
  it('项目/全局二分，全局未设时不回退项目 token 预算', () => {
    expect(resolveEffectiveTokenBudget('p1', 1000, 2000)).toBe(1000)
    expect(resolveEffectiveTokenBudget(undefined, 1000, undefined)).toBe(0)
  })
})
