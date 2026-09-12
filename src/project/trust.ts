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
import type { Config } from '../shared/types/config.js'

/** 单个风险项：kind 供前端图标/文案映射，detail 为人类可读说明。 */
export type TrustRiskItem = {
  kind: 'permission-auto' | 'permission-timeout-deny' | 'plugins-enabled' | 'mcp-enabled'
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
    const names = plugins.filter((p): p is string => typeof p === 'string')
    if (names.length > 0) {
      items.push({ kind: 'plugins-enabled', detail: `启用项目插件：${names.join('、')}` })
    }
  }

  // P0：MCP 服务器（stdio 类会在项目信任边界内本地执行任意命令，与插件同级的
  // 任意代码执行面）。任何非空 mcpServers 数组都拦截——fail-closed，绝不静默
  // 加载克隆仓库自带的 MCP 进程。
  const mcpServers = raw.mcpServers
  if (Array.isArray(mcpServers) && mcpServers.length > 0) {
    const names = (mcpServers as unknown[]).map((m) => {
      const e = (typeof m === 'object' && m !== null ? m : {}) as {
        name?: unknown
        command?: unknown
        transport?: unknown
      }
      if (typeof e.name === 'string' && e.name.length > 0) return e.name
      if (typeof e.command === 'string' && e.command.length > 0) return e.command
      return typeof e.transport === 'string' ? e.transport : '（未命名）'
    })
    items.push({
      kind: 'mcp-enabled',
      detail: `启用 MCP 服务器：${names.join('、')}（stdio 类会在本地执行命令）`,
    })
  }

  return items
}

/**
 * 计算项目作用域风险配置的指纹：无风险项 → ''（空串）；有 → sha256(canonical risks)。
 * fingerprint 作为信任时的「批准快照」落盘（projects.riskFingerprint）。之后每次
 * 门禁评估重算当前指纹并比对，检测「信任后配置漂移」——仓库 git pull 新增了 auto
 * 权限/插件/MCP 等风险键时指纹变化，重新触发信任确认，而非永久信任。
 * canonical 形式 = 按 kind 排序的 `kind:detail` 行；detail 含插件名/MCP 名，故新增
 * 插件/MCP 也会改变指纹（正确触发复检）。
 */
export function computeProjectRiskFingerprint(raw: Partial<Config> | undefined): string {
  const risks = summarizeProjectRisk(raw)
  if (risks.length === 0) return ''
  const canonical = risks
    .map((r) => `${r.kind}:${r.detail}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * 判定项目是否需要（重新）信任：返回「需要用户确认的风险项」数组，空数组 = 放行。
 * 门禁条件：
 *  - 未信任：项目风险 或 全局权限风险（auto / timeoutAction=deny）任一存在即拦。
 *    全局权限风险兜底「仓库未携带 .c0de 但本机已全局 auto」的裸奔场景。
 *  - 已信任：仅当项目作用域配置指纹漂移（git pull 新增风险键）时复检；
 *    全局配置是用户本机显式选择，不因漂移重新门禁。
 * 供 Web 聊天入口（返回 409）与 CLI agent 路径（抛错引导 c0de trust）共用，
 * 保证两处「什么时候拦」判定完全一致，不再各自为政。
 */
export function projectTrustNeeded(
  raw: Partial<Config> | undefined,
  globalRaw: Partial<Config> | undefined,
  trustedAt: number | null | undefined,
  riskFingerprint: string | null | undefined,
): TrustRiskItem[] {
  const projectRisks = summarizeProjectRisk(raw)
  const untrusted = trustedAt == null

  if (untrusted) {
    return mergeRiskItems(projectRisks, globalPermissionRiskItems(globalRaw))
  }

  if (projectRisks.length === 0) return []
  const currentFp = computeProjectRiskFingerprint(raw)
  return riskFingerprint !== currentFp ? projectRisks : []
}
