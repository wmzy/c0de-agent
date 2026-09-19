import {
  applyScopedPatch,
  loadConfigScopes,
  mergeConfig,
  saveConfigScoped,
} from '../../core/config.js'
import { coerce, getByPath, setPathPatch } from '../../core/config-path.js'
import type { Config } from '../../shared/types/config.js'
import type { CommandArgs } from '../parser.js'

/**
 * P1：config set 写入项目作用域后刷新信任指纹（serve 未运行时生效）。
 * config 命令无 agent deps 生命周期，此处独立打开持久库；serve 运行期间
 * 持久库被占用（单写者）——跳过刷新，配置已落盘，信任复检的 fail-closed
 * 路径兜底（下次聊天一次性确认，风险项即本次修改）。
 */
async function refreshTrustFingerprint(cwd: string): Promise<void> {
  try {
    const { mkdirSync } = await import('node:fs')
    const { createDB, migrateDB } = await import('../../db/index.js')
    const { acquireDevDbLock, releaseDevDbLock, resolveDbDir } = await import(
      '../../server/server.js'
    )
    const { getByDirectory, trustProject } = await import('../../project/index.js')
    const dataDir = resolveDbDir()
    mkdirSync(dataDir, { recursive: true })
    acquireDevDbLock(dataDir)
    try {
      const db = await createDB({ driver: 'pglite', dataDir })
      try {
        await migrateDB(db)
        const p = await getByDirectory(db, cwd)
        if (p?.trustedAt != null) await trustProject(db, p.id)
      } finally {
        await db.close()
      }
    } finally {
      releaseDevDbLock(dataDir)
    }
  } catch {
    // serve 锁冲突/库错误等：跳过刷新，不阻塞配置写入结果
  }
}

type ConfigCommandContext = {
  args: CommandArgs
  cwd: string
  write?: (s: string) => void
  /** 测试注入：覆盖指纹刷新实现（缺省走真实持久库路径）。 */
  refreshTrust?: (cwd: string) => Promise<void>
}

async function runConfigCommand(ctx: ConfigCommandContext): Promise<void> {
  const write = ctx.write ?? process.stdout.write.bind(process.stdout)
  const sub = ctx.args.positionals[0]
  const scopes = loadConfigScopes(ctx.cwd)
  // get 展示用合并视图（global ← project，含默认值），与 loadConfig 语义一致。
  const config: Config = mergeConfig(scopes.global, scopes.project)
  // 未知顶层键告警（loadConfig 只在 serve/chat 启动路径调用；config 命令走 loadConfigScopes）。
  const { warnUnknownConfigKeys } = await import('../../core/config.js')
  warnUnknownConfigKeys('global', scopes.global)
  warnUnknownConfigKeys('project', scopes.project)

  if (sub === 'get') {
    const key = ctx.args.positionals[1]
    const { redactSecrets } = await import('../../core/redact.js')
    if (!key) {
      // 展示前脱敏：apiKey/token 明文绝不输出到终端（P0 密钥暴露）。
      write(`${JSON.stringify(redactSecrets(config), null, 2)}\n`)
      return
    }
    // 用点路径末段作为键名参与脱敏判定：config get security.token 等单键读取同样掩码。
    const leaf = key.split('.').pop()
    const val = redactSecrets(getByPath(config, key), leaf)
    write(`${typeof val === 'object' ? JSON.stringify(val) : String(val)}\n`)
    return
  }

  if (sub === 'set') {
    const key = ctx.args.positionals[1]
    const rawArg = ctx.args.positionals[2]
    if (!key) throw new Error('config set: a key is required')
    if (rawArg === undefined) throw new Error('config set: a value is required')
    // 顶层键校验：拒绝拼写错误/过时键，避免写入永不生效的配置（此前静默接受）。
    const { KNOWN_CONFIG_KEYS } = await import('../../core/config.js')
    const topKey = key.split('.')[0] ?? ''
    if (!KNOWN_CONFIG_KEYS.has(topKey)) {
      throw new Error(
        `config set: 未知的顶层配置键 "${topKey}"。有效键：${[...KNOWN_CONFIG_KEYS].join(', ')}`,
      )
    }
    const scope = (ctx.args.options.global as boolean | undefined) ? 'global' : 'project'
    // 作用域收敛：security 是服务端全局参数，项目作用域写入会被加载时剥离（不生效）。
    // 与其写入一个永不生效的键，不如直接拒绝并给出正解路径（与 Web PATCH /api/config 同语义）。
    if (scope === 'project' && topKey === 'security') {
      throw new Error(
        'config set: security 是服务端全局参数，仅在全局作用域生效。请加 --global 写入全局配置。',
      )
    }
    // 只把 patch 合并进目标作用域的原始文件，不写入默认值与其他作用域的配置（P2-3）。
    // 值为 null → 删除该键（作用域内取消覆盖，回落另一作用域/默认值）。
    const scopeCfg = scope === 'global' ? scopes.global : scopes.project
    const value = coerce(rawArg)
    const next = applyScopedPatch(scopeCfg ?? {}, setPathPatch(key, value))
    await saveConfigScoped(scope, ctx.cwd, next)
    // P1：项目作用域写入是用户显式操作——已信任项目刷新风险指纹（与 Web
    // PATCH /api/config、/config 斜杠命令同口径），防「信任 → 改配置 → 再信任」
    // 自锁复检循环。
    if (scope === 'project') {
      await (ctx.refreshTrust ?? refreshTrustFingerprint)(ctx.cwd)
    }
    write(`${value === null ? '已取消设置' : '已设置'} ${key} (scope: ${scope})\n`)
    return
  }

  throw new Error(`config: unknown subcommand "${sub ?? ''}" (expected get|set)`)
}

export type { ConfigCommandContext }
export { coerce, getByPath, runConfigCommand, setPathPatch }
