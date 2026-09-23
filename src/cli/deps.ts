import { loadConfigScopes } from '../core/config.js'
import type { LoopDeps } from '../core/loop.js'
import { buildRegistryFromConfig } from '../core/provider-registry.js'
import { discoverSkills } from '../core/skills.js'
import { createDebugSpawn } from '../dap/index.js'
import type { DB } from '../db/client.js'
import { collectScopedMCPServers, registerMCPServers } from '../mcp/index.js'
import { initPlugins } from '../plugins/index.js'
import { getByDirectory } from '../project/index.js'
import { projectTrustCurrent } from '../project/trust.js'
import type { Config } from '../shared/types/config.js'
import type { ToolContext, ToolDef } from '../shared/types/tool.js'
import { createDefaultRegistry, createDefaultURLRegistry } from '../tools/index.js'
import { autoAllowChecker } from '../tools/permission.js'
import type { PermissionChecker, PermissionResult } from '../tools/types.js'

/** 权限策略：
 * - 'full-auto'：所有工具无条件放行（print/acp 等非交互模式）。
 * - 'safe'（默认）：只读工具放行，写/执行工具需确认（chat 等 agent 自主执行场景）。 */
type PermissionStrategy = 'full-auto' | 'safe'

/** 真正非交互模式（print/acp）：所有工具无条件放行（命令由用户显式触发）。 */
const fullyAutoApproveChecker: PermissionChecker = {
  check: async (_tool: ToolDef, _input: unknown, _ctx: ToolContext): Promise<PermissionResult> => {
    return { _tag: 'allow' }
  },
  confirm: (_toolCallId: string, _approved: boolean) => {},
}

/**
 * 非交互模式（print）安全策略（P1-6）：ask 工具**直接拒绝**并给出可操作提示
 * （-y 或 serve），而非返回 permission_required 让 LLM 在无确认通道下无限重试。
 * 拒绝原因作为 tool result 交给模型，模型会向用户转述。
 * `allowTools`（--allow 白名单）内的 ask 工具改为放行，提供「全拒 / 全放行」之间的
 * 逐工具粒度；未列出的 ask 工具仍拒绝。
 */
function createNonInteractiveChecker(allowTools?: string[]): PermissionChecker {
  const allowSet = new Set(allowTools ?? [])
  return {
    check: async (tool: ToolDef, _input: unknown, _ctx: ToolContext): Promise<PermissionResult> => {
      const result = await autoAllowChecker.check(tool, _input, _ctx)
      if (result._tag === 'ask') {
        if (allowSet.has(tool.name)) return { _tag: 'allow' }
        return {
          _tag: 'deny',
          reason: `非交互模式：工具 "${tool.name}" 需要确认。请加 -y 全量放行、--allow <工具名> 定向放行，或使用 c0de serve 交互确认`,
        }
      }
      return result
    },
    confirm: autoAllowChecker.confirm,
  }
}

/** 无白名单的非交互安全策略（保留导出兼容既有调用方）。 */
const nonInteractiveSafeChecker: PermissionChecker = createNonInteractiveChecker()

type BuildDepsOptions = {
  db: DB
  cwd: string
  /** 权限策略：'full-auto' 全部放行；'safe' 只读放行、写操作 ask。不传时按
   * config.permission.defaultMode 决定（'auto'→full-auto，'default'→safe）。 */
  permissionStrategy?: PermissionStrategy
  /** --allow 白名单（safe 模式下 ask 工具定向放行）。 */
  allowTools?: string[]
  /** 测试注入 mock chatStream。 */
  chatStream?: LoopDeps['chatStream']
}

/** 解析权限 checker：显式策略优先，否则回退到 config.permission.defaultMode。
 *  无 --allow 白名单时返回单例 nonInteractiveSafeChecker（保持对象同一性）；有白名单
 *  时按白名单新建 checker（--allow 只影响 ask 工具的定向放行）。 */
function resolvePermissionChecker(
  config: Config,
  strategy?: PermissionStrategy,
  allowTools?: string[],
): PermissionChecker {
  if (strategy === 'full-auto') return fullyAutoApproveChecker
  const listed = allowTools !== undefined && allowTools.length > 0
  if (strategy === 'safe')
    return listed ? createNonInteractiveChecker(allowTools) : nonInteractiveSafeChecker
  return config.permission.defaultMode === 'auto'
    ? fullyAutoApproveChecker
    : listed
      ? createNonInteractiveChecker(allowTools)
      : nonInteractiveSafeChecker
}

/**
 * cwd 是否当前可信项目（trustedAt 非空且指纹未漂移）。与聊天门禁/插件加载同口径；
 * CLI 工作流注册表（内置+用户级+项目级）的构建也用它决定是否 import 项目级文件。
 */
async function resolveCwdProjectTrusted(db: DB, cwd: string): Promise<boolean> {
  try {
    const p = await getByDirectory(db, cwd)
    if (p?.trustedAt != null) {
      return projectTrustCurrent(loadConfigScopes(cwd).project, p.trustedAt, p.riskFingerprint, cwd)
    }
  } catch {
    // 查询失败 → 未信任
  }
  return false
}

/** 组装完整 LoopDeps（默认 safe 放行 + 默认工具注册表）。 */
async function buildAgentDeps(config: Config, opts: BuildDepsOptions): Promise<LoopDeps> {
  const llmRegistry = buildRegistryFromConfig(config)
  const toolRegistry = createDefaultRegistry(config)
  // P0-2：项目插件仅在项目被显式信任后加载（c0de trust <dir>）；内存库
  // （--temp/锁冲突降级）不含项目记录 → 未信任，项目插件不加载。
  // P0（代码面）：已信任但指纹漂移（插件代码/MCP 参数/风险键变更）→ 不加载，
  // 与聊天门禁同口径。
  const projectTrusted = await resolveCwdProjectTrusted(opts.db, opts.cwd)
  const { hookRunner, config: resolvedConfig } = await initPlugins({
    cwd: opts.cwd,
    config,
    toolRegistry,
    llmRegistry,
    projectTrusted,
  })
  // MCP 客户端（spec §6）：全局作用域始终连接；项目作用域（随 git clone 传播的
  // 任意命令执行面）仅项目已信任时连接——与插件加载同口径。stdio 子进程已
  // unref：CLI 进程退出时 stdin 关闭，MCP 服务器自行退出。
  await registerMCPServers(
    toolRegistry,
    collectScopedMCPServers(loadConfigScopes(opts.cwd), projectTrusted),
  )
  const deps: LoopDeps = {
    db: opts.db,
    llmRegistry,
    toolRegistry,
    urlRegistry: createDefaultURLRegistry(),
    hookRunner,
    permission: resolvePermissionChecker(resolvedConfig, opts.permissionStrategy, opts.allowTools),
    config: resolvedConfig,
    cwd: opts.cwd,
    // 技能发现（system prompt ## Loaded Skills 段数据源）。
    skills: discoverSkills(opts.cwd),
    // DAP（spec §21）：CLI 宿主注入真实适配器 spawn——此前恒报「no debug adapter
    // spawn is wired」。调试会话随进程结束自然消亡（transport 子进程非 unref）。
    debugSpawn: createDebugSpawn() as LoopDeps['debugSpawn'],
    ...(opts.chatStream ? { chatStream: opts.chatStream } : {}),
    // P：预算护栏 CLI 变体——print/acp 无恢复 UI，超支中止 run（产出 error）而非
    // 暂停永久挂起。金额与 token 任一动作='pause'/'abort' 即启用（每轮 LLM 请求前检查）。
    ...(resolvedConfig.usage?.budgetAction === 'pause' ||
    resolvedConfig.usage?.budgetAction === 'abort' ||
    resolvedConfig.usage?.tokenBudgetAction === 'pause' ||
    resolvedConfig.usage?.tokenBudgetAction === 'abort'
      ? { budgetAbort: true }
      : {}),
  }
  return deps
}

export type { BuildDepsOptions, PermissionStrategy }
export {
  buildAgentDeps,
  buildRegistryFromConfig,
  fullyAutoApproveChecker,
  nonInteractiveSafeChecker,
  resolveCwdProjectTrusted,
}
