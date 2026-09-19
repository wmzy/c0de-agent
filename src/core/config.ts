import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
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
import { encryptSecret, isEncryptedSecret } from './secret.js'

const GLOBAL_CONFIG_DIR = '.c0de'
const CONFIG_FILENAME = 'config.json'

/**
 * 全局配置根目录：默认 `~/.c0de`；C0DE_CONFIG_DIR 环境变量可整体重定向
 * （相对路径按进程 cwd 解析），全局工作流/插件同样落于此根下。
 * 与 C0DE_DB_DIR 同口径——开发隔离场景把全局配置从安装版默认位置切到独立目录。
 */
function resolveGlobalConfigDir(): string {
  const envDir = process.env.C0DE_CONFIG_DIR?.trim()
  if (envDir) return isAbsolute(envDir) ? envDir : resolve(envDir)
  return join(homedir(), GLOBAL_CONFIG_DIR)
}

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
  // enabled 语义（P1-1 修复「空=全部」安全陷阱）：
  //   ['*']（通配）= 启用全部注册工具（默认）；[] = 无工具（fail-closed）；
  //   非空名单 = 默认工具集。CLI print 与 Web chat 统一经 resolveEnabledToolNames 解析。
  tools: { enabled: ['*'], disabled: [] },
  plugins: { enabled: [] },
  mcpServers: [],
  slashCommands: {
    enabled: ['/compact', '/model', '/clear', '/help', '/fork', '/config', '/workflow'],
  },
  toolMetrics: { enabled: true, threshold: 0.8, minSamples: 5 },
  security: { authEnabled: true, allowedOrigins: [] },
  websearch: { provider: 'auto' },
  agents: { subagentConcurrency: 3 },
  permission: { defaultMode: 'default', timeoutAction: 'pause' },
  usage: {
    monthlyBudgetUsd: 0,
    globalMonthlyBudgetUsd: 0,
    monthlyTokenBudget: 0,
    globalMonthlyTokenBudget: 0,
    budgetAction: 'warn',
  },
  update: { enabled: true, intervalMs: 60 * 60 * 1000, initialDelayMs: 10_000 },
  theme: 'system',
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
 * usage 下「全局口径」预算键——仅 global 作用域生效。项目作用域写入这些键
 * 会被忽略（作用域收敛）：此前「项目配置里设全局预算无意义但会生效」既造成
 * 双预算语义混乱，又会随 git clone 传播、未被信任门禁拦截。收敛后项目作用域
 * 的这两键不再进入任何合并视图，也不随 clone 影响本机护栏。
 */
const GLOBAL_ONLY_USAGE_KEYS = ['globalMonthlyBudgetUsd', 'globalMonthlyTokenBudget'] as const

/**
 * 项目作用域中「服务端/全局生效、随 git clone 传播有安全风险」的顶层键：整体剥离。
 * `security` 是服务级信任边界（鉴权开关 / token / CORS origin / 首设备窗口）——单进程
 * 多项目架构下不存在「按项目」的安全参数。此前项目配置可静默改写服务端安全参数
 * （如 authEnabled:false、security.token 静态弱 token、allowedOrigins 放宽），且这些键
 * 不在信任门禁的风险 kind（trust.ts summarizeProjectRisk）内，克隆仓库即可无确认生效。
 * 收敛为 global-only：security 仅从全局作用域读取。
 */
const PROJECT_SERVER_ONLY_KEYS = ['security'] as const

/** 从项目作用域原始配置中剥离「服务端/全局」键（security 顶层键 + usage 全局口径预算键）。
 *  浅拷贝，不改入参；无剥离键时原样返回（保持身份，调用方可安全比较）。 */
function stripProjectServerKeys(project: Partial<Config> | undefined): Partial<Config> | undefined {
  if (!project) return project
  let stripped = false
  const next: Record<string, unknown> = { ...(project as Record<string, unknown>) }

  // 顶层「服务端/全局」键整体移除（见 PROJECT_SERVER_ONLY_KEYS）。
  for (const k of PROJECT_SERVER_ONLY_KEYS) {
    if (k in next) {
      delete next[k]
      stripped = true
    }
  }

  // usage 下全局口径预算键移除（仅 global 作用域生效）。
  const usage = project.usage
  if (typeof usage === 'object' && usage !== null && !Array.isArray(usage)) {
    const u = { ...(usage as Record<string, unknown>) }
    for (const k of GLOBAL_ONLY_USAGE_KEYS) {
      if (k in u) {
        delete u[k]
        stripped = true
      }
    }
    next.usage = u
  }

  if (!stripped) return project
  return next as Partial<Config>
}

/**
 * 返回项目作用域**原始文件**中出现的全局口径预算键名（strip 前的原始内容）。
 * 供设置页告警展示：这些键来自旧版本或手动编辑，加载时已被剥离、不再生效。
 */
function projectGlobalOnlyUsageKeys(projectDir?: string): string[] {
  const raw = readJsonIfExists(join(projectDir ?? process.cwd(), '.c0de', CONFIG_FILENAME))
  const usage = raw?.usage
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return []
  return GLOBAL_ONLY_USAGE_KEYS.filter((k) => k in (usage as Record<string, unknown>))
}

/**
 * 返回项目作用域**原始文件**中出现的 security 子键名（strip 前的原始内容）。
 * 供设置页告警展示：security 是服务端全局参数，随项目配置出现时已被剥离、不再生效。
 */
function projectSecurityKeys(projectDir?: string): string[] {
  const raw = readJsonIfExists(join(projectDir ?? process.cwd(), '.c0de', CONFIG_FILENAME))
  const sec = raw?.security
  if (typeof sec !== 'object' || sec === null || Array.isArray(sec)) return []
  return Object.keys(sec as Record<string, unknown>)
}

/**
 * 读取项目作用域原始文件内容（不剥离 security/全局键）。
 * 供「文件原文」敏感的检查使用——被剥离的键仍可能携带明文密钥（如 security.token），
 * 配置落在 git 仓库内同样要防误提交，不能因键不生效而漏掉警告。
 */
function loadProjectRawScope(projectDir?: string): Partial<Config> | undefined {
  return readJsonIfExists(join(projectDir ?? process.cwd(), '.c0de', CONFIG_FILENAME))
}

/**
 * 读取 global/project 两个作用域的**原始文件内容**（不经 DEFAULT 合并）。
 * 供配置持久化使用：写回某个作用域时只落该作用域应有的键，
 * 避免把合并结果（含默认值与另一作用域的配置）整体序列化进文件。
 * 项目作用域经 stripProjectServerKeys 收敛——security 与全局口径预算键只会从 global 读。
 */
function loadConfigScopes(projectDir?: string): {
  global: Partial<Config> | undefined
  project: Partial<Config> | undefined
} {
  const globalPath = join(resolveGlobalConfigDir(), CONFIG_FILENAME)
  const projectPath = join(projectDir ?? process.cwd(), '.c0de', CONFIG_FILENAME)
  return {
    global: readJsonIfExists(globalPath),
    project: stripProjectServerKeys(readJsonIfExists(projectPath)),
  }
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

/** 把 raw JSON 写回指定作用域配置文件（不含默认值）。
 *  - 落盘前对 providers[].apiKey 加密（已带 enc: 前缀/空值透传）——
 *    CLI config set 与 /config 斜杠命令共用此路径，保证「apiKey 不明文落盘」全链路成立。
 *  - 写入后 chmod 600：配置文件可能含 token/加密密钥，默认 0644 同机可读。 */
async function saveConfigScoped(
  scope: 'global' | 'project',
  projectDir: string | undefined,
  data: Record<string, unknown>,
): Promise<void> {
  const dir =
    scope === 'global' ? resolveGlobalConfigDir() : join(projectDir ?? process.cwd(), '.c0de')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, CONFIG_FILENAME)
  const hardened = redactSensitiveOnSave(data)
  writeFileSync(path, JSON.stringify(hardened, null, 2), 'utf-8')
  try {
    chmodSync(path, 0o600)
  } catch {
    // 平台不支持（Windows 等）时忽略；内容仍已加密。
  }
}

/** 落盘前的敏感值处理：providers[].apiKey 与 websearch 后端 key 明文 → enc: 加密
 *  （spec §24.2；此前 websearch.tavilyApiKey/braveApiKey 明文落盘，与 provider
 *  apiKey 安全叙事不一致——git 误提交警告会命中它们，加密却不会）。 */
function redactSensitiveOnSave(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(data)) {
    if (key === 'providers' && Array.isArray(val)) {
      out[key] = (val as unknown[]).map((p) => {
        if (p === null || typeof p !== 'object') return p
        const apiKey = (p as Record<string, unknown>).apiKey
        if (typeof apiKey === 'string' && apiKey.length > 0 && !isEncryptedSecret(apiKey)) {
          return { ...(p as Record<string, unknown>), apiKey: encryptSecret(apiKey) }
        }
        return p
      })
      continue
    }
    if (key === 'websearch' && val !== null && typeof val === 'object') {
      const ws = { ...(val as Record<string, unknown>) }
      for (const k of ['tavilyApiKey', 'braveApiKey'] as const) {
        const v = ws[k]
        if (typeof v === 'string' && v.length > 0 && !isEncryptedSecret(v)) {
          ws[k] = encryptSecret(v)
        }
      }
      out[key] = ws
      continue
    }
    out[key] = val
  }
  return out
}

async function loadConfig(projectDir?: string): Promise<Config> {
  const globalPath = join(resolveGlobalConfigDir(), CONFIG_FILENAME)
  const projectPath = join(projectDir ?? process.cwd(), '.c0de', CONFIG_FILENAME)
  const global = readJsonIfExists(globalPath)
  // 与 loadConfigScopes 同口径剥离：security 与 usage 全局口径预算键不进合并视图
  // （此前 loadConfig 不剥离，服务启动目录项目的 security/全局预算键会静默生效——
  //  安全键可被克隆仓库无确认改写，全局预算可被项目作用域注入）。
  const projectRaw = readJsonIfExists(projectPath)
  const project = stripProjectServerKeys(projectRaw)
  // 项目配置遗留 security 键（旧版本/手动编辑/克隆仓库自带）→ CLI 侧明示已忽略，
  // 与 Web 设置页 securityWarnings 同口径（stderr 可见，不必等到打开设置页）。
  const rawSecurity = projectRaw?.security
  if (typeof rawSecurity === 'object' && rawSecurity !== null && !Array.isArray(rawSecurity)) {
    const keys = Object.keys(rawSecurity as Record<string, unknown>)
    if (keys.length > 0) {
      console.warn(
        `[config] 项目配置含 security 键（${keys.join('、')}，服务端全局参数），已忽略——` +
          `请在全局配置（${join(resolveGlobalConfigDir(), CONFIG_FILENAME)}）或 c0de config set --global 设置。`,
      )
    }
  }
  warnUnknownConfigKeys('global', global)
  warnUnknownConfigKeys('project', project)
  for (const [scope, data] of [
    ['global', global],
    ['project', project],
  ] as const) {
    for (const w of collectConfigMigrationWarnings(scope, data)) console.warn(`[config] ${w}`)
  }
  return mergeConfig(global, project)
}

/**
 * P0-1：配置迁移告警（返回值，供 Web 设置页 warnings 展示；CLI 侧 console.warn
 * 复用）。检测语义翻转/易混淆键：
 *  - tools.enabled: [] —— 旧版含义「启用全部」已改为「禁用全部」（fail-closed），
 *    老用户升级后会静默失去全部工具，必须在 Web 界面可见（不只落在 stderr）。
 *  - slashCommands.enabled: [] —— 旧版含义「全部启用」已同步改为「禁用全部」
 *    （与 tools.enabled 语义统一），升级后斜杠命令将全部失效，须显式引导。
 */
export function collectConfigMigrationWarnings(
  scope: 'global' | 'project',
  data: Record<string, unknown> | undefined,
): string[] {
  if (!data) return []
  const scopeLabel = scope === 'global' ? '全局' : '项目'
  const out: string[] = []
  const tools = data.tools
  if (typeof tools === 'object' && tools !== null && !Array.isArray(tools)) {
    const enabled = (tools as Record<string, unknown>).enabled
    if (Array.isArray(enabled) && enabled.length === 0) {
      out.push(
        `${scopeLabel}配置的 tools.enabled 为空数组：旧版含义「启用全部」已改为「禁用全部」——` +
          `如需启用全部，请改为 ["*"]，或删除该键恢复默认值。`,
      )
    }
  }
  const slash = data.slashCommands
  if (typeof slash === 'object' && slash !== null && !Array.isArray(slash)) {
    const enabled = (slash as Record<string, unknown>).enabled
    if (Array.isArray(enabled) && enabled.length === 0) {
      out.push(
        `${scopeLabel}配置的 slashCommands.enabled 为空数组：旧版含义「全部启用」已改为「禁用全部」` +
          `（与 tools.enabled 语义统一）——如需启用全部，请改为 ["*"]，或删除该键恢复默认值。`,
      )
    }
  }
  return out
}

/** Config 全部顶层键（DEFAULT_CONFIG + 可选键）。未知顶层键校验与告警共用。 */
const KNOWN_CONFIG_KEYS = new Set<string>([
  ...Object.keys(DEFAULT_CONFIG),
  // 可选键不在 DEFAULT_CONFIG 中（缺失=未配置），但属于合法键。
  'commitModel',
])

/** 收集对象中不属于 Config 顶层键的未知键。 */
function collectUnknownConfigKeys(data: Record<string, unknown> | undefined): string[] {
  if (!data) return []
  return Object.keys(data).filter((k) => !KNOWN_CONFIG_KEYS.has(k))
}

/** 加载配置时对未知顶层键告警（拼写错误/旧版键静默失效的唯一提示）。 */
function warnUnknownConfigKeys(
  scope: 'global' | 'project',
  data: Record<string, unknown> | undefined,
): void {
  const unknown = collectUnknownConfigKeys(data)
  if (unknown.length === 0) return
  console.warn(
    `[config] ${scope} 配置包含未知键：${unknown.join(', ')}。` +
      `这些键不会生效——请检查拼写，或移除过时配置。有效顶层键：${[...KNOWN_CONFIG_KEYS].join(', ')}`,
  )
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
  collectUnknownConfigKeys,
  DEFAULT_CONFIG,
  GLOBAL_ONLY_USAGE_KEYS,
  KNOWN_CONFIG_KEYS,
  loadConfig,
  loadConfigScopes,
  loadProjectRawScope,
  mergeConfig,
  mergeRaw,
  projectGlobalOnlyUsageKeys,
  projectSecurityKeys,
  resolveGlobalConfigDir,
  saveConfigScoped,
  stripProjectServerKeys,
  warnUnknownConfigKeys,
}
