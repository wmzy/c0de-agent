import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyScopedPatch,
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
    expect(DEFAULT_CONFIG.tools.enabled).toEqual([])
    expect(DEFAULT_CONFIG.fallback.maxRetries).toBe(3)
  })

  it('tools.enabled empty means all registered tools', () => {
    expect(DEFAULT_CONFIG.tools.enabled).toEqual([])
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
