// src/project/trust.test.ts — P0-2 项目信任风险检测单元测试。
import { describe, expect, it } from 'vitest'
import type { Config } from '../shared/types/config.js'
import { summarizeProjectRisk } from './trust.js'

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
