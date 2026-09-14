import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyScopedPatch,
  collectConfigMigrationWarnings,
  DEFAULT_CONFIG,
  loadConfig,
  loadConfigScopes,
  mergeConfig,
  mergeRaw,
  saveConfigScoped,
} from './config.js'

const tmp = join(tmpdir(), `c0de-config-test-${Date.now()}`)

beforeEach(() => mkdirSync(tmp, { recursive: true }))
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('DEFAULT_CONFIG', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_CONFIG.providers).toEqual([])
    expect(DEFAULT_CONFIG.compaction.enabled).toBe(true)
    expect(DEFAULT_CONFIG.compaction.threshold).toBe(0.8)
    expect(DEFAULT_CONFIG.tools.enabled).toEqual(['*'])
    expect(DEFAULT_CONFIG.fallback.maxRetries).toBe(3)
  })

  it('tools.enabled defaults to ["*"] (all registered tools)', () => {
    expect(DEFAULT_CONFIG.tools.enabled).toEqual(['*'])
    expect(DEFAULT_CONFIG.tools.disabled).toEqual([])
  })

  it('websearch defaults to auto provider with no keys', () => {
    expect(DEFAULT_CONFIG.websearch.provider).toBe('auto')
    expect(DEFAULT_CONFIG.websearch.tavilyApiKey).toBeUndefined()
    expect(DEFAULT_CONFIG.websearch.braveApiKey).toBeUndefined()
  })

  it('permission defaults to default mode', () => {
    expect(DEFAULT_CONFIG.permission.defaultMode).toBe('default')
  })
})

describe('mergeConfig', () => {
  it('returns DEFAULT when no overrides', () => {
    const merged = mergeConfig()
    expect(merged.defaultModel).toBe(DEFAULT_CONFIG.defaultModel)
  })

  it('overrides top-level keys', () => {
    const merged = mergeConfig({ defaultModel: 'gpt-5' })
    expect(merged.defaultModel).toBe('gpt-5')
  })

  it('deep-merges nested objects', () => {
    const merged = mergeConfig({
      compaction: { threshold: 0.9, enabled: true, reserveTokens: 8000, keepRecentTokens: 4000 },
    })
    expect(merged.compaction.threshold).toBe(0.9)
    expect(merged.compaction.enabled).toBe(true)
  })

  it('later overrides win', () => {
    const merged = mergeConfig({ defaultModel: 'a' }, { defaultModel: 'b' })
    expect(merged.defaultModel).toBe('b')
  })

  it('replaces arrays, not concatenates', () => {
    const merged = mergeConfig({ providers: [{ name: 'x', protocol: 'openai', apiKey: 'k' }] })
    expect(merged.providers).toHaveLength(1)
  })

  it('deep-merges permission override', () => {
    const merged = mergeConfig({ permission: { defaultMode: 'auto' } })
    expect(merged.permission.defaultMode).toBe('auto')
  })
})

describe('saveConfigScoped / loadConfig', () => {
  it('saves and loads project config', async () => {
    await saveConfigScoped('project', tmp, { defaultModel: 'claude' })
    const loaded = await loadConfig(tmp)
    expect(loaded.defaultModel).toBe('claude')
  })

  it('returns defaults when no config files exist', async () => {
    const loaded = await loadConfig(tmp)
    // Config is valid regardless of global state
    expect(loaded).toHaveProperty('defaultModel')
    expect(loaded).toHaveProperty('compaction')
    expect(loaded.compaction).toHaveProperty('threshold')
  })

  it('project config overrides defaults', async () => {
    await saveConfigScoped('project', tmp, { defaultModel: 'project-model' })
    const loaded = await loadConfig(tmp)
    expect(loaded.defaultModel).toBe('project-model')
  })

  it('loadConfigScopes 剥离项目作用域的全局口径预算键（作用域收敛）', async () => {
    await saveConfigScoped('project', tmp, {
      usage: { monthlyBudgetUsd: 50, globalMonthlyBudgetUsd: 999, globalMonthlyTokenBudget: 88 },
    })
    const scopes = loadConfigScopes(tmp)
    const usage = (scopes.project?.usage ?? {}) as {
      monthlyBudgetUsd?: number
      globalMonthlyBudgetUsd?: number
      globalMonthlyTokenBudget?: number
    }
    expect(usage.monthlyBudgetUsd).toBe(50)
    expect(usage.globalMonthlyBudgetUsd).toBeUndefined()
    expect(usage.globalMonthlyTokenBudget).toBeUndefined()
  })

  it('loadConfigScopes 剥离项目作用域的 security（服务端全局参数，作用域收敛）', async () => {
    await saveConfigScoped('project', tmp, {
      security: {
        authEnabled: false,
        token: 'weak-known-token',
        allowedOrigins: ['https://evil.example'],
      },
      defaultModel: 'project-model',
    })
    const scopes = loadConfigScopes(tmp)
    expect(scopes.project?.security).toBeUndefined()
    // 非剥离键不受影响
    expect(scopes.project?.defaultModel).toBe('project-model')
  })

  it('loadConfig 合并视图同样不受项目 security 影响（启动路径同口径剥离）', async () => {
    await saveConfigScoped('project', tmp, {
      security: { authEnabled: false, token: 'weak-known-token' },
    })
    const loaded = await loadConfig(tmp)
    // 项目 security 不生效：authEnabled 回落默认值 true
    expect(loaded.security.authEnabled).toBe(true)
    expect(loaded.security.token).toBeUndefined()
  })

  it('projectSecurityKeys 报告项目作用域原始文件中出现的 security 子键（供设置页告警）', async () => {
    await saveConfigScoped('project', tmp, {
      security: { authEnabled: false, allowedOrigins: [] },
    })
    const { projectSecurityKeys } = await import('./config.js')
    expect(projectSecurityKeys(tmp).sort()).toEqual(['allowedOrigins', 'authEnabled'])
  })

  it('saveConfigScoped 落盘前加密 providers[].apiKey（不明文持久化）', async () => {
    const { decryptSecret, encryptSecret, isEncryptedSecret } = await import('./secret.js')
    const preEncrypted = encryptSecret('sk-orig')
    await saveConfigScoped('project', tmp, {
      providers: [
        { name: 'demo', protocol: 'openai-compat', apiKey: 'sk-plain-key-123', baseURL: '' },
        { name: 'pre', protocol: 'openai-compat', apiKey: preEncrypted, baseURL: '' },
        { name: 'empty', protocol: 'openai-compat', apiKey: '', baseURL: '' },
      ],
    })
    const onDisk = JSON.parse(readFileSync(join(tmp, '.c0de', 'config.json'), 'utf-8')) as {
      providers: Array<{ name: string; apiKey: string }>
    }
    expect(onDisk.providers[0]?.apiKey).not.toContain('sk-plain-key-123')
    expect(isEncryptedSecret(onDisk.providers[0]?.apiKey ?? '')).toBe(true)
    expect(decryptSecret(onDisk.providers[0]?.apiKey ?? '')).toBe('sk-plain-key-123')
    // 已加密透传、空值透传
    expect(onDisk.providers[1]?.apiKey).toBe(preEncrypted)
    expect(onDisk.providers[2]?.apiKey).toBe('')
  })

  it('saveConfigScoped 写入后配置文件权限为 600', async () => {
    const { statSync } = await import('node:fs')
    await saveConfigScoped('project', tmp, { defaultModel: 'perm-model' })
    const mode = statSync(join(tmp, '.c0de', 'config.json')).mode & 0o777
    // Windows 无 POSIX 权限语义，跳过断言
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600)
    }
  })
})

describe('agents config', () => {
  it('DEFAULT_CONFIG 含 agents 字段', () => {
    expect(DEFAULT_CONFIG.agents).toBeDefined()
    expect(DEFAULT_CONFIG.agents.dir).toBe('.c0de/agents')
    expect(DEFAULT_CONFIG.agents.subagentConcurrency).toBe(3)
  })

  it('mergeConfig 合并 agents 字段', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      agents: { dir: '.custom/agents', subagentConcurrency: 5 },
    })
    expect(merged.agents?.subagentConcurrency).toBe(5)
  })
})

// 作用域隔离：loadConfigScopes/saveConfigScoped 读写 homedir() → process.env.HOME（POSIX），
// 用临时 HOME 隔离测试，避免污染真实全局配置文件（同 workflows 测试的既有模式）。
describe('applyScopedPatch（scoped patch，null=删除）', () => {
  it('null 顶层键：从作用域文件删除（回落默认值/另一作用域）', () => {
    const base = { defaultModel: 'proj-model', theme: 'dark' }
    expect(applyScopedPatch(base, { defaultModel: null })).toEqual({ theme: 'dark' })
  })

  it('null 嵌套键：仅删除嵌套键', () => {
    const base = { compaction: { enabled: false, threshold: 0.5 } }
    expect(applyScopedPatch(base, { compaction: { threshold: null } })).toEqual({
      compaction: { enabled: false },
    })
  })

  it('undefined 跳过；普通对象递归合并；数组整体替换', () => {
    const base = { tools: { enabled: ['read'] }, websearch: { provider: 'auto' } }
    const patch = {
      tools: { enabled: ['write'], disabled: undefined },
      websearch: { provider: 'tavily' },
    }
    expect(applyScopedPatch(base, patch)).toEqual({
      tools: { enabled: ['write'] },
      websearch: { provider: 'tavily' },
    })
  })

  it('空 patch 原样返回 base 副本', () => {
    const base = { a: 1 }
    const next = applyScopedPatch(base, {})
    expect(next).toEqual({ a: 1 })
    expect(next).not.toBe(base)
  })
})

describe('loadConfigScopes / mergeRaw / saveConfigScoped 作用域隔离', () => {
  const originalHome = process.env.HOME
  let homeDir: string
  let projectDir: string

  beforeEach(() => {
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    homeDir = join(tmpdir(), `c0de-scope-home-${uniq}`)
    projectDir = join(tmpdir(), `c0de-scope-proj-${uniq}`)
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    process.env.HOME = homeDir
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('saveConfigScoped(project) 只写项目层：global 层保持不存在（不被默认值/项目值污染）', async () => {
    await saveConfigScoped('project', projectDir, { defaultModel: 'proj-model' })
    const scopes = loadConfigScopes(projectDir)
    expect(scopes.project).toEqual({ defaultModel: 'proj-model' })
    expect(scopes.global).toBeUndefined()
  })

  it('saveConfigScoped(global) 与 project 层互不污染（各层只含本层写入的键）', async () => {
    await saveConfigScoped('global', projectDir, { theme: 'dark' })
    await saveConfigScoped('project', projectDir, { defaultModel: 'proj-model' })
    const scopes = loadConfigScopes(projectDir)
    expect(scopes.global).toEqual({ theme: 'dark' })
    expect(scopes.project).toEqual({ defaultModel: 'proj-model' })
  })

  it('mergeRaw 不注入默认值：嵌套对象递归合并、数组整体替换', () => {
    const merged = mergeRaw(
      { compaction: { enabled: false, threshold: 0.5 } },
      { compaction: { threshold: 0.9 } },
    )
    expect(merged).toEqual({ compaction: { enabled: false, threshold: 0.9 } })

    const withArr = mergeRaw({ tools: { enabled: ['read'] } }, { tools: { enabled: ['write'] } })
    expect(withArr).toEqual({ tools: { enabled: ['write'] } })

    // 空合并不产生默认键（区别于 mergeConfig 的 DEFAULT 兜底）
    expect(mergeRaw()).toEqual({})
  })

  it('patch 流程：loadConfigScopes + mergeRaw 改全局层单键，project 层原样不动', async () => {
    // 模拟 config set --global：读全局原始层 → patch 一个键 → 写回全局层
    await saveConfigScoped('project', projectDir, { defaultModel: 'proj-model', theme: 'light' })
    const { global } = loadConfigScopes(projectDir)
    await saveConfigScoped('global', projectDir, mergeRaw(global, { defaultModel: 'global-model' }))

    const scopes = loadConfigScopes(projectDir)
    expect(scopes.global).toEqual({ defaultModel: 'global-model' })
    // 项目层未被全局 patch 触碰
    expect(scopes.project).toEqual({ defaultModel: 'proj-model', theme: 'light' })
  })

  it('loadConfig 合并两层：project 覆盖 global，未覆盖键回落 DEFAULT 而非落盘', async () => {
    await saveConfigScoped('global', projectDir, { defaultModel: 'global-model' })
    await saveConfigScoped('project', projectDir, { defaultModel: 'proj-model' })
    const loaded = await loadConfig(projectDir)
    expect(loaded.defaultModel).toBe('proj-model')
    expect(loaded.compaction.enabled).toBe(DEFAULT_CONFIG.compaction.enabled)
    // 默认值只在加载态合并，不写回任何作用域文件
    const scopes = loadConfigScopes(projectDir)
    expect(scopes.global).toEqual({ defaultModel: 'global-model' })
    expect(scopes.project?.compaction).toBeUndefined()
  })
})

describe('collectConfigMigrationWarnings（P0-1 配置迁移告警）', () => {
  it('tools.enabled 空数组 → 告警（旧「全启」已改为「全禁」）', () => {
    const out = collectConfigMigrationWarnings('project', { tools: { enabled: [] } })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('tools.enabled 为空数组')
    expect(out[0]).toContain('["*"]')
  })

  it('slashCommands.enabled 空数组 → 告警（仍是全启，与 tools 相反）', () => {
    const out = collectConfigMigrationWarnings('global', { slashCommands: { enabled: [] } })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('slashCommands.enabled 为空数组')
    expect(out[0]).toContain('["*"]')
  })

  it('非空数组 / 缺省不告警', () => {
    expect(collectConfigMigrationWarnings('project', { tools: { enabled: ['read'] } })).toEqual([])
    expect(collectConfigMigrationWarnings('project', {})).toEqual([])
    expect(collectConfigMigrationWarnings('project', undefined)).toEqual([])
    expect(
      collectConfigMigrationWarnings('project', { slashCommands: { enabled: ['/help'] } }),
    ).toEqual([])
  })

  it('两层都含空数组时分别标记作用域', () => {
    const g = collectConfigMigrationWarnings('global', { tools: { enabled: [] } })
    const p = collectConfigMigrationWarnings('project', { tools: { enabled: [] } })
    expect(g[0]).toContain('全局配置')
    expect(p[0]).toContain('项目配置')
  })
})
