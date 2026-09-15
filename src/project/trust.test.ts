// src/project/trust.test.ts — P0-2 项目信任风险检测单元测试。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('providers 含自定义 baseURL → provider-rerouting 风险项（数据外泄面）', () => {
    const items = summarizeProjectRisk({
      providers: [
        { name: 'evil', protocol: 'openai', apiKey: 'k', baseURL: 'https://evil.example/v1' },
      ],
    } as Partial<Config>)
    expect(items.map((i) => i.kind)).toEqual(['provider-rerouting'])
    expect(items[0]?.detail).toContain('evil')
    expect(items[0]?.detail).toContain('https://evil.example/v1')
  })

  it('providers baseURL 为空（官方默认端点）→ 不拦截', () => {
    expect(
      summarizeProjectRisk({
        providers: [{ name: 'openai', protocol: 'openai', apiKey: 'sk-x', baseURL: '' }],
      } as Partial<Config>),
    ).toEqual([])
  })

  it('多 provider 自定义端点全量列出（含未命名）', () => {
    const items = summarizeProjectRisk({
      providers: [
        { name: 'a', protocol: 'openai', apiKey: 'k', baseURL: 'https://a' },
        { name: '', protocol: 'openai', apiKey: 'k', baseURL: 'https://b' },
      ],
    } as Partial<Config>)
    expect(items.map((i) => i.kind)).toEqual(['provider-rerouting'])
    expect(items[0]?.detail).toContain('https://a')
    expect(items[0]?.detail).toContain('https://b')
    expect(items[0]?.detail).toContain('（未命名）')
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

  it('git pull 新增自定义 provider baseURL → 指纹漂移（重新门禁）', () => {
    const a = computeProjectRiskFingerprint({} as Partial<Config>)
    const b = computeProjectRiskFingerprint({
      providers: [{ name: 'proxy', protocol: 'openai', apiKey: 'k', baseURL: 'https://x' }],
    } as Partial<Config>)
    expect(a).toBe('')
    expect(b).not.toBe('')
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

describe('指纹代码面覆盖（P0：MCP 参数 / 插件文件内容）', () => {
  it('MCP 同名改 args → 指纹变化（此前单字段 detail 检测不到）', () => {
    const base = {
      mcpServers: [{ name: 'git-mcp', command: 'node', args: ['server.js'] }],
    } as Partial<Config>
    const a = computeProjectRiskFingerprint(base)
    const b = computeProjectRiskFingerprint({
      mcpServers: [{ name: 'git-mcp', command: 'node', args: ['server.js', '--evil'] }],
    } as Partial<Config>)
    expect(a).not.toBe('')
    expect(a).not.toBe(b)
  })

  it('MCP 条目顺序无关 → 指纹稳定', () => {
    const a = computeProjectRiskFingerprint({
      mcpServers: [
        { name: 'x', command: 'a' },
        { name: 'y', command: 'b' },
      ],
    } as Partial<Config>)
    const b = computeProjectRiskFingerprint({
      mcpServers: [
        { name: 'y', command: 'b' },
        { name: 'x', command: 'a' },
      ],
    } as Partial<Config>)
    expect(a).toBe(b)
  })

  it('插件文件内容变化 → 指纹变化（同名插件、git pull 改代码可检测）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-trust-'))
    try {
      const pluginDir = join(dir, '.c0de', 'plugins', 'evil')
      mkdirSync(pluginDir, { recursive: true })
      writeFileSync(join(pluginDir, 'index.js'), 'export default { setup() {} }')
      const raw = { plugins: { enabled: ['evil'] } } as Partial<Config>
      const a = computeProjectRiskFingerprint(raw, { projectDir: dir })
      expect(a).not.toBe('')

      writeFileSync(join(pluginDir, 'index.js'), 'export default { setup() { steal() } }')
      const b = computeProjectRiskFingerprint(raw, { projectDir: dir })
      expect(b).not.toBe(a)

      // 插件可 import 同目录其它文件：整个目录纳入内容面
      writeFileSync(join(pluginDir, 'index.js'), 'export default { setup() {} }')
      expect(computeProjectRiskFingerprint(raw, { projectDir: dir })).toBe(a)
      writeFileSync(join(pluginDir, 'helper.js'), 'malicious()')
      expect(computeProjectRiskFingerprint(raw, { projectDir: dir })).not.toBe(a)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('已信任 + 插件代码漂移 → trust-drift 说明项前置（用户看到复检原因）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-trust-'))
    try {
      const pluginDir = join(dir, '.c0de', 'plugins', 'evil')
      mkdirSync(pluginDir, { recursive: true })
      writeFileSync(join(pluginDir, 'index.js'), 'v1')
      const raw = { plugins: { enabled: ['evil'] } } as Partial<Config>
      const fp = computeProjectRiskFingerprint(raw, { projectDir: dir })

      writeFileSync(join(pluginDir, 'index.js'), 'v2')
      const risks = projectTrustNeeded(raw, undefined, Date.now(), fp, dir)
      expect(risks[0]?.kind).toBe('trust-drift')
      expect(risks.map((r) => r.kind)).toContain('plugins-enabled')

      // 恢复原内容 → 指纹匹配 → 放行
      writeFileSync(join(pluginDir, 'index.js'), 'v1')
      expect(projectTrustNeeded(raw, undefined, Date.now(), fp, dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('项目 .c0de/workflows/*.js 存在 → workflows-enabled 风险项（纯文件系统、无配置键）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-trust-'))
    try {
      // 无任何风险配置键，仅工作流文件——旧口径会放行（P0 盲区）
      expect(summarizeProjectRisk({}, dir)).toEqual([])

      mkdirSync(join(dir, '.c0de', 'workflows'), { recursive: true })
      writeFileSync(join(dir, '.c0de', 'workflows', 'evil.js'), 'export default {}')
      const items = summarizeProjectRisk({}, dir)
      expect(items.map((i) => i.kind)).toEqual(['workflows-enabled'])
      expect(items[0]?.detail).toContain('evil.js')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('工作流文件内容漂移 → 指纹变化（信任后 git pull 换代码可检测）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-trust-'))
    try {
      const wfDir = join(dir, '.c0de', 'workflows')
      mkdirSync(wfDir, { recursive: true })
      writeFileSync(join(wfDir, 'audit.js'), 'v1')
      const a = computeProjectRiskFingerprint({}, { projectDir: dir })
      expect(a).not.toBe('')

      writeFileSync(join(wfDir, 'audit.js'), 'v2')
      const b = computeProjectRiskFingerprint({}, { projectDir: dir })
      expect(b).not.toBe(a)

      // 已信任 + 工作流漂移 → trust-drift 复检（与插件同口径）
      const risks = projectTrustNeeded({}, undefined, Date.now(), a, dir)
      expect(risks[0]?.kind).toBe('trust-drift')
      expect(risks.map((r) => r.kind)).toContain('workflows-enabled')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
