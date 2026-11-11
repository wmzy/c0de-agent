// src/cli/commands/auth.ts — 设备管理与认证恢复（P1-4/P2-5）。
//
// 本地终端是可信信道：唯一设备丢失（浏览器数据清空）导致配对死锁时，
// 用户可通过 `c0de auth reset` 清除设备注册表，重启 serve 后用启动日志
// 打印的带 token URL 重新注册首台设备。
// 运行中的 serve 通过 authManager 的 devices.json watcher 热加载 revoke/reset 变更。

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { readDevicesFile, writeDevicesFile } from '../../server/auth-manager.js'
import { resolveDbDir } from '../../server/server.js'
import type { CommandArgs } from '../parser.js'

type AuthCommandContext = {
  args: CommandArgs
  write?: (s: string) => void
}

function devicesPath(): string {
  return join(resolveDbDir(), 'devices.json')
}

function authTokenPath(): string {
  return join(resolveDbDir(), 'auth-token')
}

async function runAuthCommand(ctx: AuthCommandContext): Promise<void> {
  const write = ctx.write ?? ((s: string) => process.stdout.write(s))
  const sub = ctx.args.positionals[0] ?? 'list'

  if (sub === 'list') {
    // 读侧与 serve 共用 readDevicesFile（单一实现）：逐字段防御 + 损坏视为空
    // （fail-closed，与认证侧一致——此前 CLI 副本损坏即 throw，容错相反）。
    const devices = readDevicesFile(devicesPath())
    if (devices.length === 0) {
      write('无已授权设备。\n')
      return
    }
    for (const d of devices) {
      write(`- ${d.name}  (id: ${d.id}, 注册于 ${new Date(d.createdAt).toISOString()})\n`)
    }
    return
  }

  if (sub === 'revoke') {
    const id = ctx.args.positionals[1]
    if (!id) throw new Error('auth revoke: a device id is required (use `c0de auth list`)')
    const devices = readDevicesFile(devicesPath())
    const target = devices.find((d) => d.id === id)
    if (!target) throw new Error(`auth revoke: device not found: ${id}`)
    writeDevicesFile(
      devicesPath(),
      devices.filter((d) => d.id !== id),
    )
    write(`已撤销设备 "${target.name}"（${id}）。运行中的 serve 将立即生效。\n`)
    return
  }

  if (sub === 'reset') {
    // 清除设备注册表 + bootstrap：恢复到「未注册」状态。
    // 运行中的 serve 经 watcher 热清空内存设备；bootstrap 在重启后重新生成并打印。
    try {
      rmSync(devicesPath(), { force: true })
      rmSync(authTokenPath(), { force: true })
    } catch (err) {
      throw new Error(`auth reset: ${err instanceof Error ? err.message : String(err)}`)
    }
    write('已清除全部已授权设备与认证 token。\n')
    write('恢复步骤：重启 c0de serve，然后打开启动日志中打印的带 ?token= 的 URL 注册首台设备。\n')
    return
  }

  throw new Error(`auth: unknown subcommand "${sub}" (expected list|revoke|reset)`)
}

export type { AuthCommandContext }
export { runAuthCommand }
