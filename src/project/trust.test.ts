// src/project/trust.test.ts — P0-2 项目信任风险检测单元测试。
import { describe, expect, it } from 'vitest'
import type { Config } from '../shared/types/config.js'
import {
  computeProjectRiskFingerprint,
  enrichProjectRiskWithGlobal,
  projectTrustNeeded,
  summarizeProjectRisk,
} from './trust.js'

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

  it('mcpServers 非空 → mcp-enabled 风险项（stdio 执行命令明确提示）', () => {
    const items = summarizeProjectRisk({
      mcpServers: [{ name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y'] }],
    } as Partial<Config>)
    expect(items.map((i) => i.kind)).toEqual(['mcp-enabled'])
    expect(items[0]?.detail).toContain('filesystem')
    expect(items[0]?.detail).toContain('stdio')
  })

  it('mcpServers 空数组 → 不拦截', () => {
    expect(summarizeProjectRisk({ mcpServers: [] } as Partial<Config>)).toEqual([])
  })

  it('mcpServers 非法漂移（null）→ 不拦截（与项目 JSON 非法值一致忽略）', () => {
    expect(summarizeProjectRisk({ mcpServers: null } as unknown as Partial<Config>)).toEqual([])
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

describe('computeProjectRiskFingerprint / projectTrustNeeded', () => {
  it('无风险 → 指纹为空串', () => {
    expect(computeProjectRiskFingerprint(undefined)).toBe('')
    expect(computeProjectRiskFingerprint({})).toBe('')
    expect(
      computeProjectRiskFingerprint({ permission: { defaultMode: 'default' } } as Partial<Config>),
    ).toBe('')
  })

  it('风险配置变化 → 指纹变化（漂移可检测）', () => {
    const a = computeProjectRiskFingerprint({
      permission: { defaultMode: 'auto' },
    } as Partial<Config>)
    const b = computeProjectRiskFingerprint({
      permission: { defaultMode: 'auto' },
      plugins: { enabled: ['evil'] },
    } as Partial<Config>)
    expect(a).not.toBe('')
    expect(a).not.toBe(b)
  })

  it('风险子集顺序无关 → 指纹稳定（避免无谓复检）', () => {
    const a = computeProjectRiskFingerprint({
      permission: { defaultMode: 'auto', timeoutAction: 'deny' },
    } as Partial<Config>)
    const b = computeProjectRiskFingerprint({
      permission: { timeoutAction: 'deny', defaultMode: 'auto' },
    } as Partial<Config>)
    expect(a).toBe(b)
  })

  it('projectTrustNeeded：未信任 + 有风险 → 返回风险项（需门禁）', () => {
    const risks = projectTrustNeeded(
      { permission: { defaultMode: 'auto' } } as Partial<Config>,
      undefined,
      null,
      null,
    )
    expect(risks.map((r) => r.kind)).toEqual(['permission-auto'])
  })

  it('projectTrustNeeded：已信任 + 指纹匹配 → 空（不拦截）', () => {
    const raw = { permission: { defaultMode: 'auto' } } as Partial<Config>
    const fp = computeProjectRiskFingerprint(raw)
    expect(projectTrustNeeded(raw, undefined, Date.now(), fp)).toEqual([])
  })

  it('projectTrustNeeded：已信任 + 指纹漂移 → 返回风险项（重新门禁）', () => {
    const raw = {
      permission: { defaultMode: 'auto' },
      plugins: { enabled: ['evil'] },
    } as Partial<Config>
    const staleFp = computeProjectRiskFingerprint({
      permission: { defaultMode: 'auto' },
    } as Partial<Config>)
    const risks = projectTrustNeeded(raw, undefined, Date.now(), staleFp)
    expect(risks.map((r) => r.kind)).toContain('plugins-enabled')
  })

  it('projectTrustNeeded：无风险无论信任状态 → 空（永不拦截）', () => {
    expect(projectTrustNeeded({}, undefined, null, null)).toEqual([])
    expect(projectTrustNeeded({}, undefined, Date.now(), 'stale-fp')).toEqual([])
  })

  it('未信任 + 全局 auto（项目无风险）→ 返回全局权限风险项（兜底门禁）', () => {
    const risks = projectTrustNeeded(
      {},
      { permission: { defaultMode: 'auto' } } as Partial<Config>,
      null,
      null,
    )
    expect(risks.map((r) => r.kind)).toEqual(['permission-auto'])
    expect(risks[0]?.detail).toContain('全局配置')
  })

  it('未信任 + 全局 timeoutAction=deny（项目无风险）→ 返回全局超时风险项', () => {
    const risks = projectTrustNeeded(
      {},
      { permission: { timeoutAction: 'deny' } } as Partial<Config>,
      null,
      null,
    )
    expect(risks.map((r) => r.kind)).toEqual(['permission-timeout-deny'])
  })

  it('已信任 + 全局 auto（项目无风险）→ 放行（全局不复检）', () => {
    expect(
      projectTrustNeeded(
        {},
        { permission: { defaultMode: 'auto' } } as Partial<Config>,
        Date.now(),
        null,
      ),
    ).toEqual([])
  })

  it('未信任 + 项目/全局同 kind → 去重（项目 detail 优先）', () => {
    const risks = projectTrustNeeded(
      { permission: { defaultMode: 'auto' } } as Partial<Config>,
      { permission: { defaultMode: 'auto' } } as Partial<Config>,
      null,
      null,
    )
    expect(risks).toHaveLength(1)
    expect(risks[0]?.detail).not.toContain('全局配置')
  })
})
