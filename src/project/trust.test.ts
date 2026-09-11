// src/project/trust.test.ts — P0-2 项目信任风险检测单元测试。
import { describe, expect, it } from 'vitest'
import type { Config } from '../shared/types/config.js'
import { enrichProjectRiskWithGlobal, summarizeProjectRisk } from './trust.js'

describe('summarizeProjectRisk', () => {
  it('无项目配置 → 无风险', () => {
    expect(summarizeProjectRisk(undefined)).toEqual([])
    expect(summarizeProjectRisk({})).toEqual([])
  })

  it('defaultMode=auto → permission-auto 风险项', () => {
    const items = summarizeProjectRisk({ permission: { defaultMode: 'auto' } } as Partial<Config>)
    expect(items.map((i) => i.kind)).toEqual(['permission-auto'])
    expect(items[0]?.detail).toContain('auto')
  })

  it('defaultMode=default → 不拦截（默认安全值）', () => {
    expect(
      summarizeProjectRisk({ permission: { defaultMode: 'default' } } as Partial<Config>),
    ).toEqual([])
  })

  it('timeoutAction=deny → permission-timeout-deny 风险项', () => {
    const items = summarizeProjectRisk({
      permission: { timeoutAction: 'deny' },
    } as Partial<Config>)
    expect(items.map((i) => i.kind)).toEqual(['permission-timeout-deny'])
    expect(items[0]?.detail).toContain('timeoutAction')
  })

  it('timeoutAction=pause → 不拦截（默认安全值）', () => {
    expect(
      summarizeProjectRisk({ permission: { timeoutAction: 'pause' } } as Partial<Config>),
    ).toEqual([])
  })

  it('plugins.enabled 非空 → plugins-enabled 风险项（仅字符串名）', () => {
    const items = summarizeProjectRisk({
      plugins: { enabled: ['p-a', 42] as unknown as string[] },
    } as Partial<Config>)
    expect(items.map((i) => i.kind)).toEqual(['plugins-enabled'])
    expect(items[0]?.detail).toContain('p-a')
    expect(items[0]?.detail).not.toContain('42')
  })

  it('plugins.enabled 空数组 → 不拦截', () => {
    expect(summarizeProjectRisk({ plugins: { enabled: [] } } as Partial<Config>)).toEqual([])
  })

  it('多风险项全量列出', () => {
    const items = summarizeProjectRisk({
      permission: { defaultMode: 'auto', timeoutAction: 'deny' },
      plugins: { enabled: ['p-a'] },
    } as Partial<Config>)
    expect(items.map((i) => i.kind)).toEqual([
      'permission-auto',
      'permission-timeout-deny',
      'plugins-enabled',
    ])
  })
})

describe('enrichProjectRiskWithGlobal', () => {
  it('全局无风险 → 原样返回（无全局配置）', () => {
    const risks = summarizeProjectRisk({ plugins: { enabled: ['p'] } } as Partial<Config>)
    expect(enrichProjectRiskWithGlobal(risks, undefined)).toEqual(risks)
  })

  it('全局 auto 并入项目风险（项目未含 auto），detail 标注来源', () => {
    const risks = summarizeProjectRisk({ plugins: { enabled: ['p'] } } as Partial<Config>)
    const items = enrichProjectRiskWithGlobal(risks, {
      permission: { defaultMode: 'auto' },
    } as Partial<Config>)
    expect(items.map((i) => i.kind)).toEqual(['plugins-enabled', 'permission-auto'])
    const globalItem = items.find((i) => i.kind === 'permission-auto')
    expect(globalItem?.detail).toContain('全局配置')
  })

  it('项目已含 auto → 不重复并入全局 auto', () => {
    const risks = summarizeProjectRisk({ permission: { defaultMode: 'auto' } } as Partial<Config>)
    const items = enrichProjectRiskWithGlobal(risks, {
      permission: { defaultMode: 'auto' },
    } as Partial<Config>)
    expect(items).toHaveLength(1)
    expect(items[0]?.detail).not.toContain('全局配置')
  })

  it('全局 timeoutAction=deny 并入项目风险，项目已含则跳过', () => {
    const empty = summarizeProjectRisk(undefined)
    const withDeny = enrichProjectRiskWithGlobal(empty, {
      permission: { timeoutAction: 'deny' },
    } as Partial<Config>)
    expect(withDeny.map((i) => i.kind)).toEqual(['permission-timeout-deny'])
    expect(withDeny[0]?.detail).toContain('全局配置')

    const already = summarizeProjectRisk({
      permission: { timeoutAction: 'deny' },
    } as Partial<Config>)
    const noDup = enrichProjectRiskWithGlobal(already, {
      permission: { timeoutAction: 'deny' },
    } as Partial<Config>)
    expect(noDup).toHaveLength(1)
  })

  it('全局合法值（default/pause）不并入', () => {
    const risks = summarizeProjectRisk({ plugins: { enabled: ['p'] } } as Partial<Config>)
    expect(
      enrichProjectRiskWithGlobal(risks, {
        permission: { defaultMode: 'default', timeoutAction: 'pause' },
      } as Partial<Config>),
    ).toEqual(risks)
  })
})
