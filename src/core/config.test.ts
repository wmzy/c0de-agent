import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Config } from '../shared/types/config.js'
import {
  applyScopedPatch,
  collectConfigMigrationWarnings,
  DEFAULT_CONFIG,
  loadConfig,
  loadConfigScopes,
  mergeConfig,
  mergeRaw,
  resolveGlobalConfigDir,
  saveConfigScoped,
} from './config.js'
import { getByPath, setPathPatch } from './config-path.js'

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
    expect(DEFAULT_CONFIG.agents.subagentConcurrency).toBe(3)
  })

  it('mergeConfig 合并 agents 字段', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      agents: { subagentConcurrency: 5 },
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

  // 回归：JSON 数值文法允许 1e999（解析为 Infinity）——JSON.stringify 落盘为
  // null，键被静默删除：设置超大预算（或超长更新间隔）变成「预算/护栏键关闭」，
  // 且写入通道回显「已设置」。写入面必须显式拒绝非有限数值。
  it('rejects non-finite numbers (JSON 1e999 → Infinity) anywhere in the patch', () => {
    expect(() =>
      applyScopedPatch({}, { usage: { monthlyBudgetUsd: Number.POSITIVE_INFINITY } }),
    ).toThrow(/非有限/)
    expect(() =>
      applyScopedPatch({}, { update: { intervalMs: Number.NEGATIVE_INFINITY } }),
    ).toThrow(/非有限/)
    // 数组内同样拒绝（providers 等）
    expect(() =>
      applyScopedPatch({}, { providers: [{ costPer1kInput: Number.POSITIVE_INFINITY }] }),
    ).toThrow()
    // 合法数值与 null 删除语义不受影响
    expect(applyScopedPatch({}, { usage: { monthlyBudgetUsd: 100 } })).toEqual({
      usage: { monthlyBudgetUsd: 100 },
    })
    expect(applyScopedPatch({ a: 1 }, { a: null })).toEqual({})
  })

  it('providers 畸形条目显式拒绝（此前 REST 500 / 落盘毒化 / 启动击穿）', () => {
    expect(() => applyScopedPatch({}, { providers: [null] })).toThrow(/providers\[0\]/)
    expect(() => applyScopedPatch({}, { providers: ['oops'] })).toThrow(/providers\[0\]/)
    expect(() => applyScopedPatch({}, { providers: [{}] })).toThrow(/providers\[0\].*name/)
    expect(() => applyScopedPatch({}, { providers: [{ name: 'x', baseURL: 123 }] })).toThrow(
      /baseURL/,
    )
    expect(() => applyScopedPatch({}, { providers: [{ name: 'x', apiKey: 123 }] })).toThrow(
      /apiKey/,
    )
    // 合法条目（含 _tag 旧格式与空数组）原样通过
    expect(applyScopedPatch({}, { providers: [{ name: 'demo', protocol: 'openai' }] })).toEqual({
      providers: [{ name: 'demo', protocol: 'openai' }],
    })
    expect(applyScopedPatch({}, { providers: [{ _tag: 'legacy' }] })).toEqual({
      providers: [{ _tag: 'legacy' }],
    })
    expect(applyScopedPatch({}, { providers: [] })).toEqual({ providers: [] })
    expect(applyScopedPatch({ a: 1 }, { providers: null })).toEqual({ a: 1 })
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

  it('slashCommands.enabled 空数组 → 告警（旧「全启」已同步改为「全禁」）', () => {
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

// 回归：点路径与 JSON 配置键都可能携带原型链键（`__proto__`/`constructor`/
// `prototype`）。它们不可能是合法配置键（KNOWN_CONFIG_KEYS 不含），但经普通赋值
// 会改写原型链：setByPath 沿 `__proto__` 段继续下钻时拿到的是 Object.prototype，
// 末段直接写进全局原型——进程内所有对象/数组凭空多出该属性（配置「已设置」，
// JSON.stringify 落盘时又静默丢弃），且 /config 斜杠命令对点路径无顶层键校验
// （模型即可触发）。JSON 文件里的自持 `__proto__` 键（手改/克隆仓库自带）经
// 合并路径同样把结果对象的原型换掉：键不可枚举、不可序列化，读起来像「配置没写」。
describe('原型链键（__proto__/constructor/prototype）不可作为配置键', () => {
  it('setPathPatch 拒绝原型链段（此前直接写进 Object.prototype）', () => {
    expect(() => setPathPatch('providers.__proto__.polluted', 'yes')).toThrow(/__proto__/)
    expect(() => setPathPatch('__proto__.polluted', 'yes')).toThrow()
    expect(() => setPathPatch('providers.constructor.prototype.polluted', 'yes')).toThrow()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(([] as unknown as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('getByPath 拒绝原型链段（此前 /config __proto__ 会打印 Object.prototype）', () => {
    expect(() => getByPath({ a: 1 }, '__proto__')).toThrow(/__proto__/)
    expect(() => getByPath({ a: { b: 1 } }, 'a.constructor')).toThrow()
    // 普通点路径读写不受影响
    expect(getByPath({ a: { b: 1 } }, 'a.b')).toBe(1)
    expect(setPathPatch('a.b', 1)).toEqual({ a: { b: 1 } })
  })

  it('applyScopedPatch 跳过 JSON 自持 __proto__ 键（不改写结果原型、不污染全局）', () => {
    const patch = JSON.parse('{"__proto__":{"polluted":true},"theme":"dark"}') as Record<
      string,
      unknown
    >
    const next = applyScopedPatch({}, patch)
    expect(next).toEqual({ theme: 'dark' })
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype)
    expect((next as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('mergeRaw/mergeConfig 跳过配置文件中的 __proto__ 键', () => {
    const raw = JSON.parse('{"__proto__":{"polluted":true},"theme":"dark"}') as Partial<Config>
    expect(mergeRaw(raw)).toEqual({ theme: 'dark' })

    const merged = mergeConfig(raw)
    expect(merged.theme).toBe('dark')
    expect((merged as unknown as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('loadConfig 读取含 __proto__ 键的配置文件：合并视图无该键、原型未被改写', async () => {
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const dir = join(tmpdir(), `c0de-proto-proj-${uniq}`)
    mkdirSync(join(dir, '.c0de'), { recursive: true })
    writeFileSync(
      join(dir, '.c0de', 'config.json'),
      '{"__proto__":{"polluted":true},"theme":"dark"}',
      'utf-8',
    )
    try {
      const loaded = await loadConfig(dir)
      expect(loaded.theme).toBe('dark')
      expect((loaded as unknown as Record<string, unknown>).polluted).toBeUndefined()
      expect(Object.getPrototypeOf(loaded)).toBe(Object.prototype)
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveGlobalConfigDir（C0DE_CONFIG_DIR 重定向）', () => {
  const prevEnv = process.env.C0DE_CONFIG_DIR
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.C0DE_CONFIG_DIR
    else process.env.C0DE_CONFIG_DIR = prevEnv
  })

  it('未设置 → ~/.c0de', () => {
    delete process.env.C0DE_CONFIG_DIR
    expect(resolveGlobalConfigDir()).toBe(join(homedir(), '.c0de'))
  })

  it('绝对路径 → 原样使用', () => {
    process.env.C0DE_CONFIG_DIR = '/tmp/c0de-isolated-config'
    expect(resolveGlobalConfigDir()).toBe('/tmp/c0de-isolated-config')
  })

  it('相对路径 → 按进程 cwd 解析', () => {
    process.env.C0DE_CONFIG_DIR = '.c0de-dev'
    expect(resolveGlobalConfigDir()).toBe(resolve(process.cwd(), '.c0de-dev'))
  })

  it('空白值 → 回落默认 ~/.c0de', () => {
    process.env.C0DE_CONFIG_DIR = '   '
    expect(resolveGlobalConfigDir()).toBe(join(homedir(), '.c0de'))
  })
})
