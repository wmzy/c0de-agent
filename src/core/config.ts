import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentsConfig,
  CompactionConfig,
  Config,
  MCPServerConfig,
  PermissionConfig,
  SecurityConfig,
  ToolMetricsConfig,
  UpdateConfig,
  WebSearchConfig,
} from '../shared/types/config.js'

const GLOBAL_CONFIG_DIR = '.c0de'
const CONFIG_FILENAME = 'config.json'

const DEFAULT_CONFIG: Config = {
  providers: [],
  defaultProvider: 'openai',
  defaultModel: 'gpt-4o',
  roleRouting: {},
  fallback: { enabled: false, maxRetries: 3, retryDelay: 2000 },
  compaction: {
    enabled: true,
    threshold: 0.8,
    reserveTokens: 8000,
    keepRecentTokens: 4000,
    midTurnEnabled: false,
  },
  // enabled 为空 = 启用全部注册工具（registry 层过滤 disabled）。
  // 非空 = 默认工具集。CLI print 与 Web chat 统一经 resolveEnabledToolNames 解析。
  tools: { enabled: [], disabled: [] },
  plugins: { enabled: [] },
  mcpServers: [],
  slashCommands: { enabled: ['/compact', '/model', '/clear', '/help', '/fork', '/config'] },
  toolMetrics: { enabled: true, threshold: 0.8, minSamples: 5 },
  security: { authEnabled: true, allowedOrigins: [] },
  websearch: { provider: 'auto' },
  agents: { dir: '.c0de/agents', subagentConcurrency: 3 },
  permission: { defaultMode: 'default' },
  update: { enabled: true, intervalMs: 60 * 60 * 1000, initialDelayMs: 10_000 },
  theme: 'system',
  locale: 'en',
}

function mergeConfig(...configs: (Partial<Config> | undefined)[]): Config {
  const result: Config = structuredClone(DEFAULT_CONFIG)
  for (const cfg of configs) {
    if (!cfg) continue
    for (const key of Object.keys(cfg) as (keyof Config)[]) {
      const val = cfg[key]
      if (val === undefined) continue
      const current = result[key]
      if (
        val !== null &&
        typeof val === 'object' &&
        !Array.isArray(val) &&
        current !== null &&
        typeof current === 'object' &&
        !Array.isArray(current)
      ) {
        ;(result as Record<string, unknown>)[key] = { ...current, ...val }
      } else {
        ;(result as Record<string, unknown>)[key] = val
      }
    }
  }
  return result
}

function readJsonIfExists(path: string): Partial<Config> | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Partial<Config>
  } catch {
    return undefined
  }
}

/**
 * 读取 global/project 两个作用域的**原始文件内容**（不经 DEFAULT 合并）。
 * 供配置持久化使用：写回某个作用域时只落该作用域应有的键，
 * 避免把合并结果（含默认值与另一作用域的配置）整体序列化进文件。
 */
function loadConfigScopes(projectDir?: string): {
  global: Partial<Config> | undefined
  project: Partial<Config> | undefined
} {
  const globalPath = join(homedir(), GLOBAL_CONFIG_DIR, CONFIG_FILENAME)
  const projectPath = join(projectDir ?? process.cwd(), '.c0de', CONFIG_FILENAME)
  return { global: readJsonIfExists(globalPath), project: readJsonIfExists(projectPath) }
}

/**
 * 把 patch 应用到某个作用域的原始配置（scoped patch，null=删除）：
 * - 深合并：嵌套普通对象递归合并，数组整体替换（providers 等列表语义）；
 * - 值为 undefined 的键跳过；
 * - 值为 null 的键从结果中**删除**——作用域内取消覆盖，回落到另一作用域/默认值。
 *   Config 各字段均无合法的 null 值（可选字段用 undefined），null 作为「unset」标记是安全的。
 * 不注入默认值。CLI config set / 服务端 PATCH /api/config 共用。
 */
function applyScopedPatch(
  base: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...(base ?? {}) }
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) continue
    if (val === null) {
      delete result[key]
      continue
    }
    const current = result[key]
    if (
      typeof val === 'object' &&
      !Array.isArray(val) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      result[key] = applyScopedPatch(
        current as Record<string, unknown>,
        val as Record<string, unknown>,
      )
    } else {
      result[key] = val
    }
  }
  return result
}

/**
 * 不注入默认值的深合并：仅合并传入对象的自有键。
 * 数组整体替换（providers 等列表语义）；嵌套普通对象递归合并。
 * 用于「patch 合并进某个作用域的原始文件」后再写盘。
 */
function mergeRaw(...cfgs: (Record<string, unknown> | undefined)[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const cfg of cfgs) {
    if (!cfg) continue
    for (const [key, val] of Object.entries(cfg)) {
      if (val === undefined) continue
      const current = result[key]
      if (
        val !== null &&
        typeof val === 'object' &&
        !Array.isArray(val) &&
        current !== null &&
        typeof current === 'object' &&
        !Array.isArray(current)
      ) {
        result[key] = mergeRaw(current as Record<string, unknown>, val as Record<string, unknown>)
      } else {
        result[key] = val
      }
    }
  }
  return result
}

/** 把 raw JSON 写回指定作用域配置文件（不含默认值）。 */
async function saveConfigScoped(
  scope: 'global' | 'project',
  projectDir: string | undefined,
  data: Record<string, unknown>,
): Promise<void> {
  const dir =
    scope === 'global'
      ? join(homedir(), GLOBAL_CONFIG_DIR)
      : join(projectDir ?? process.cwd(), '.c0de')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, CONFIG_FILENAME)
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
}

async function loadConfig(projectDir?: string): Promise<Config> {
  const globalPath = join(homedir(), GLOBAL_CONFIG_DIR, CONFIG_FILENAME)
  const projectPath = join(projectDir ?? process.cwd(), '.c0de', CONFIG_FILENAME)
  const global = readJsonIfExists(globalPath)
  const project = readJsonIfExists(projectPath)
  return mergeConfig(global, project)
}

export type {
  AgentsConfig,
  CompactionConfig,
  Config,
  MCPServerConfig,
  PermissionConfig,
  SecurityConfig,
  ToolMetricsConfig,
  UpdateConfig,
  WebSearchConfig,
}
export {
  applyScopedPatch,
  DEFAULT_CONFIG,
  loadConfig,
  loadConfigScopes,
  mergeConfig,
  mergeRaw,
  saveConfigScoped,
}
