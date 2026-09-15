// src/project/trust.ts
// P0-2 项目信任边界：评估「项目作用域原始配置」中的风险项。
//
// 背景：`git clone` 一个携带 `.c0de/config.json`（或 `.c0de/plugins`）的仓库后
// `c0de serve`，此前配置静默合并生效（可把权限降级为 auto/YOLO），插件在启动时
// 直接加载执行——信任在克隆完成时被默认授予。现在：
//  - 聊天入口：未信任项目 + 风险配置 → 409 TRUST_REQUIRED（前端弹窗确认后
//    POST /api/projects/:id/trust 落盘 trustedAt，一次性）；
//  - 启动入口：未信任项目的 .c0de/plugins 不加载（信任后重启生效）。
//
// 评估「项目作用域原始配置」（loadConfigScopes(cwd).project），并额外评估
// 「全局权限风险」（permission.defaultMode=auto / timeoutAction=deny）。
// 两类入口不同：项目风险无论信任状态都参与指纹复检；全局权限风险仅当项目
// **未信任**时触发门禁（一次性，信任后不再复检）——兜底「仓库未携带 .c0de
// 但本机已全局 auto，克隆即全自动执行」的裸奔场景。全局配置的插件/MCP 是用户
// 本机显式安装（需手改 ~/.c0de），不属仓库自带风险面，不纳入门禁。
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { Config } from '../shared/types/config.js'

/** 单个风险项：kind 供前端图标/文案映射，detail 为人类可读说明。
 *  'trust-drift' 为展示专用（仅 projectTrustNeeded 在漂移时返回），
 *  不参与 summarizeProjectRisk 与指纹计算。 */
export type TrustRiskItem = {
  kind:
    | 'permission-auto'
    | 'permission-timeout-deny'
    | 'plugins-enabled'
    | 'mcp-enabled'
    | 'provider-rerouting'
    | 'trust-drift'
  detail: string
}

/** 从全局配置中提取「会作用于本项目的权限风险」项（auto 放行 / 超时后继续自主执行）。
 *  仅这两类参与门禁与可视化——全局插件/MCP 是用户本机显式安装（需手改 ~/.c0de），
 *  不属仓库自带风险面，不纳入项目信任门禁。 */
export function globalPermissionRiskItems(globalRaw: Partial<Config> | undefined): TrustRiskItem[] {
  const items: TrustRiskItem[] = []
  if (globalRaw?.permission?.defaultMode === 'auto') {
    items.push({
      kind: 'permission-auto',
      detail: '（全局配置）权限模式 auto：本机已全局设为自动放行，本项目同样生效',
    })
  }
  if (globalRaw?.permission?.timeoutAction === 'deny') {
    items.push({
      kind: 'permission-timeout-deny',
      detail: '（全局配置）权限超时动作 timeoutAction=deny：本机已全局设为超时后继续自主执行',
    })
  }
  return items
}

/** 按 kind 去重合并：primary 在前（其 detail 优先），secondary 仅补齐缺失 kind。 */
function mergeRiskItems(primary: TrustRiskItem[], secondary: TrustRiskItem[]): TrustRiskItem[] {
  const out = [...primary]
  const seen = new Set(out.map((r) => r.kind))
  for (const item of secondary) {
    if (seen.has(item.kind)) continue
    seen.add(item.kind)
    out.push(item)
  }
  return out
}

/**
 * 把「全局配置中会作用于本项目的权限风险」并入项目风险列表（作为可见上下文）。
 * 目的：用户在做信任决策时能看到完整生效的权限状态，避免「信任了项目却发现全局
 * 早已 auto」的困惑。复用现有 kind（前端无需新增映射）；同类 kind 已存在则跳过。
 */
export function enrichProjectRiskWithGlobal(
  risks: TrustRiskItem[],
  globalRaw: Partial<Config> | undefined,
): TrustRiskItem[] {
  if (!globalRaw) return risks
  return mergeRiskItems(risks, globalPermissionRiskItems(globalRaw))
}

/** 汇总项目作用域原始配置中的风险项。无风险返回空数组。
 * 宽松形状：项目 JSON 可能字段漂移，非法值一律忽略（fail-closed 由
 * 「未信任 + 无风险项 = 不拦截」与「有风险项必拦截」共同保证——解析不出
 * 风险的配置也不含可信风险）。
 */
export function summarizeProjectRisk(raw: Partial<Config> | undefined): TrustRiskItem[] {
  const items: TrustRiskItem[] = []
  if (!raw) return items

  if (raw.permission?.defaultMode === 'auto') {
    items.push({
      kind: 'permission-auto',
      detail: '权限模式 auto：bash/write/edit 等需要确认的工具将被自动放行',
    })
  }

  // 权限确认超时后的动作降级为 'deny'：安全默认是 'pause'（超时后暂停对话，
  // 防 agent 在用户缺席时继续自主执行）；'deny' 会「拒绝该工具但继续自动执行」。
  // 携带此键的可疑仓库可在不触发 auto 权限的前提下悄然弱化超时安全网。
  if (raw.permission?.timeoutAction === 'deny') {
    items.push({
      kind: 'permission-timeout-deny',
      detail:
        '权限超时动作 timeoutAction=deny：确认超时后 agent 将继续自主执行（安全默认应为 pause）',
    })
  }

  const plugins = raw.plugins?.enabled
  if (Array.isArray(plugins)) {
    const names = plugins.filter((p): p is string => typeof p === 'string').sort()
    if (names.length > 0) {
      items.push({ kind: 'plugins-enabled', detail: `启用项目插件：${names.join('、')}` })
    }
  }

  // P0：MCP 服务器（stdio 类会在项目信任边界内本地执行任意命令，与插件同级的
  // 任意代码执行面）。任何非空 mcpServers 数组都拦截——fail-closed，绝不静默
  // 加载克隆仓库自带的 MCP 进程。
  const mcpServers = raw.mcpServers
  if (Array.isArray(mcpServers) && mcpServers.length > 0) {
    const names = (mcpServers as unknown[])
      .map((m) => {
        const e = (typeof m === 'object' && m !== null ? m : {}) as {
          name?: unknown
          command?: unknown
          transport?: unknown
        }
        if (typeof e.name === 'string' && e.name.length > 0) return e.name
        if (typeof e.command === 'string' && e.command.length > 0) return e.command
        return typeof e.transport === 'string' ? e.transport : '（未命名）'
      })
      .sort() // 排序保证指纹稳定：数组重排不触发无谓复检
    items.push({
      kind: 'mcp-enabled',
      detail: `启用 MCP 服务器：${names.join('、')}（stdio 类会在本地执行命令）`,
    })
  }

  // P1：自定义 Provider 端点（baseURL 非空）会把「所有对话提示词（含代码上下文、
  // 私有文件内容）」默认路由到该第三方地址，是比 auto 权限更直接的数据外泄面。
  // 任何项目作用域配置声明了自定义 baseURL 的 provider 都拦截（fail-closed），
  // 绝不静默把请求发往非官方端点。空 baseURL（官方默认端点）不视为风险。
  const providers = raw.providers
  if (Array.isArray(providers)) {
    const custom = providers
      .map((p) => {
        const e = (typeof p === 'object' && p !== null ? p : {}) as {
          name?: unknown
          baseURL?: unknown
          baseUrl?: unknown
        }
        const url =
          typeof e.baseURL === 'string' ? e.baseURL : typeof e.baseUrl === 'string' ? e.baseUrl : ''
        return {
          name: typeof e.name === 'string' && e.name.length > 0 ? e.name : '（未命名）',
          url: url.trim(),
        }
      })
      .filter((p) => p.url.length > 0)
    if (custom.length > 0) {
      const desc = custom
        .map((p) => `${p.name} → ${p.url}`)
        .sort() // 排序保证指纹稳定：provider 数组重排不触发无谓复检
        .join('、')
      items.push({
        kind: 'provider-rerouting',
        detail: `自定义 Provider 端点（baseURL）：${desc}。你的所有对话提示词将发往该地址`,
      })
    }
  }

  return items
}

/**
 * 计算项目作用域风险配置的指纹。
 *
 * P0（代码面覆盖）：指纹不再只是配置键的 hash——已信任仓库 `git pull` 修改
 * 插件代码（同名）或 MCP `args`（同名）此前不会触发复检，下次 serve 重启即
 * 静默加载执行新代码。现在指纹由三部分组成：
 *  1. 风险项 canonical 行（kind:detail，配置键漂移）；
 *  2. MCP 服务器 canonical 参数（name+command+args+transport+url 全量，
 *     防「同名改 args」绕过）；
 *  3. 项目插件目录全部文件内容 hash（插件可 import 同目录其它文件，
 *     内容面覆盖整个插件目录，防「同名改代码」绕过）。
 * 无风险项、无 MCP、无插件 → ''（空串）。
 * 升级后旧指纹（仅配置键）与含插件/MCP 的新口径不一致 → 一次性重新确认，
 * 属预期行为（漂移复检）。
 */
export function computeProjectRiskFingerprint(
  raw: Partial<Config> | undefined,
  opts?: { projectDir?: string },
): string {
  return hashLines(fingerprintLines(raw, opts?.projectDir))
}

/** 指纹的 canonical 行集合（排序前）：风险项 + MCP 参数 + 插件文件内容。 */
function fingerprintLines(
  raw: Partial<Config> | undefined,
  projectDir: string | undefined,
): string[] {
  return [
    ...summarizeProjectRisk(raw).map((r) => `${r.kind}:${r.detail}`),
    ...mcpCanonicalLines(raw),
    ...pluginDirHashes(projectDir),
  ].sort()
}

function hashLines(lines: string[]): string {
  if (lines.length === 0) return ''
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** MCP 服务器条目的 canonical 参数行（稳定键序；非法条目跳过）。 */
function mcpCanonicalLines(raw: Partial<Config> | undefined): string[] {
  const servers = raw?.mcpServers
  if (!Array.isArray(servers)) return []
  const lines: string[] = []
  for (const m of servers) {
    if (typeof m !== 'object' || m === null) continue
    const e = m as {
      name?: unknown
      command?: unknown
      args?: unknown
      transport?: unknown
      url?: unknown
    }
    const canonical = JSON.stringify({
      name: typeof e.name === 'string' ? e.name : null,
      command: typeof e.command === 'string' ? e.command : null,
      args: Array.isArray(e.args) ? e.args : null,
      transport: typeof e.transport === 'string' ? e.transport : null,
      url: typeof e.url === 'string' ? e.url : null,
    })
    lines.push(`mcp:${canonical}`)
  }
  return lines
}

/** 项目插件目录内全部文件的内容 hash 行（相对路径 + sha256；按路径排序保证确定性）。
 *  目录不存在/不可读 → 空（指纹退化为配置口径；插件加载侧另有 fail-closed 门禁）。 */
function pluginDirHashes(projectDir: string | undefined): string[] {
  if (!projectDir) return []
  const dir = join(projectDir, '.c0de', 'plugins')
  const lines: string[] = []
  const walk = (cur: string) => {
    let entries: string[] = []
    try {
      if (!existsSync(cur)) return
      entries = readdirSync(cur).sort()
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(cur, entry)
      try {
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        const rel = relative(dir, full).split(sep).join('/')
        lines.push(
          `plugin-file:${rel}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`,
        )
      } catch {
        // 单个文件读取失败跳过（不因无法 hash 而放行或误报）
      }
    }
  }
  walk(dir)
  return lines
}

/**
 * 判定项目是否需要（重新）信任：返回「需要用户确认的风险项」数组，空数组 = 放行。
 * 门禁条件：
 *  - 未信任：项目风险 或 全局权限风险（auto / timeoutAction=deny）任一存在即拦。
 *    全局权限风险兜底「仓库未携带 .c0de 但本机已全局 auto」的裸奔场景。
 *  - 已信任：仅当项目作用域指纹漂移（git pull 新增风险键 / MCP 参数变更 /
 *    插件代码变更）时复检——返回项目风险项 + 前置 trust-drift 说明项，
 *    用户能看到「为什么又要确认」；全局配置是用户本机显式选择，不因漂移重新门禁。
 * projectDir 提供时插件文件内容纳入指纹（serve 启动的插件加载门禁与聊天入口
 * 使用同一口径）。
 * 供 Web 聊天入口（返回 409）与 CLI agent 路径（抛错引导 c0de trust）共用，
 * 保证两处「什么时候拦」判定完全一致，不再各自为政。
 */
export function projectTrustNeeded(
  raw: Partial<Config> | undefined,
  globalRaw: Partial<Config> | undefined,
  trustedAt: number | null | undefined,
  riskFingerprint: string | null | undefined,
  projectDir?: string,
): TrustRiskItem[] {
  const projectRisks = summarizeProjectRisk(raw)
  const untrusted = trustedAt == null

  if (untrusted) {
    return mergeRiskItems(projectRisks, globalPermissionRiskItems(globalRaw))
  }

  // 已信任 + 无风险键且无插件文件：无漂移面，直接放行（保持旧行为——
  // 信任后删光风险配置不触发复检）。
  const lines = fingerprintLines(raw, projectDir)
  if (lines.length === 0) return []
  const currentFp = hashLines(lines)
  if (riskFingerprint !== currentFp) {
    return [
      {
        kind: 'trust-drift',
        detail:
          '自上次信任以来，项目风险配置、MCP 参数或插件代码已变更（如仓库 git pull 更新）——需重新确认信任后才会放行',
      },
      ...projectRisks,
    ]
  }
  return []
}

/**
 * 项目是否「当前可信任」（插件加载门禁用）：已信任且指纹与信任时一致。
 * 漂移（fingerprint 不匹配）或未信任 → false（fail-closed，项目插件不加载）。
 * 供 server bootstrap 与 CLI deps 复用——插件在启动时加载，必须与聊天门禁
 * 同口径校验，否则「先重启、后门禁」的窗口里漂移代码已执行。
 */
export function projectTrustCurrent(
  raw: Partial<Config> | undefined,
  trustedAt: number | null | undefined,
  riskFingerprint: string | null | undefined,
  projectDir: string,
): boolean {
  if (trustedAt == null) return false
  return computeProjectRiskFingerprint(raw, { projectDir }) === riskFingerprint
}
