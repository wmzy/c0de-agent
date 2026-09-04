import type { DB } from '../../db/client.js'
import {
  checkForUpdate,
  type HotUpdateOptions,
  performHotUpdate,
  performInstall,
  type SessionSnapshot,
  serializeSessions,
} from '../../update/index.js'
import type { CommandArgs } from '../parser.js'

type UpdateCommandContext = {
  args: CommandArgs
  cwd: string
  /** 可选 DB：提供则把当前会话状态序列化进快照（迁移活跃会话）。 */
  db?: DB
  config?: unknown
  /** 测试注入版本检查（默认走真实 npm registry）。 */
  checkFn?: typeof checkForUpdate
  /** 透传给 performHotUpdate（测试注入 install/spawn mock）。 */
  updateOpts?: HotUpdateOptions
  out?: (s: string) => void
}

/**
 * `c0de update`：检查 npm registry 新版本。
 * - 默认：check-only，报告有无更新。
 * - `--apply`：执行热更新（序列化快照 → npm install -g → 接力新实例）。
 *   活跃会话迁移需要注入 db（server 内触发时提供；独立 CLI 无活跃会话）。
 */
async function runUpdateCommand(ctx: UpdateCommandContext): Promise<void> {
  const out = ctx.out ?? ((s: string) => process.stdout.write(`${s}\n`))
  const check = ctx.checkFn ?? checkForUpdate

  const result = await check()
  out(`当前版本 ${result.currentVersion}，最新版本 ${result.latestVersion}`)
  if (!result.hasUpdate) {
    out('已是最新版本')
    return
  }

  const apply = (ctx.args.options.apply as boolean | undefined) ?? false
  if (!apply) {
    out(`发现新版本 ${result.latestVersion}。加 --apply 执行热更新。`)
    return
  }

  // P2-7：无 db（独立 CLI，无活跃 serve）→ 仅安装，不 spawn `serve`。
  // 此前会拉起一个用户未请求的常驻服务；活跃 serve 的热更新走 /api/update/apply。
  if (!ctx.db) {
    out(`发现新版本 ${result.latestVersion}，开始安装…`)
    const r = await performInstall(ctx.updateOpts)
    if (r._tag === 'success') {
      out('安装完成。若 c0de serve 正在运行，请在页面顶部的更新横幅中应用热更新，或重启 serve。')
    } else if (r._tag === 'install_failed') {
      out(`安装失败：${r.error}`)
    } else {
      out(`无法自动安装（${r.error}）。请手动执行：${r.command}`)
    }
    return
  }

  out(`发现新版本 ${result.latestVersion}，开始热更新…`)
  const snapshot: SessionSnapshot = await serializeSessions(ctx.db, ctx.config)

  const r = await performHotUpdate(snapshot, ctx.updateOpts)
  if (r._tag === 'success') {
    out(`热更新完成，快照写入 ${r.snapshotPath}。新实例将接管。`)
  } else {
    out(`热更新失败（${r._tag}）：${'error' in r ? r.error : ''}`)
  }
}

export type { UpdateCommandContext }
export { runUpdateCommand }
