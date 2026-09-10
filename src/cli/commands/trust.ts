// src/cli/commands/trust.ts — 显式信任项目（P0-2 信任边界）。
//
// c0de trust [目录]：把目录解析/注册为项目并落盘 trustedAt。
// 未信任项目携带风险配置时 Web 聊天入口被 409 门禁拦截；项目 .c0de/plugins
// 在未信任时不加载。本命令是无 Web 场景（headless/CI 前手工审查过仓库）的信任途径。
// 与 sessions 命令同约束：需要持久库，serve 运行期间报错引导走 Web 界面。

import type { DB } from '../../db/client.js'
import { fromDirectory, trustProject } from '../../project/project.js'
import type { CommandArgs } from '../parser.js'

type TrustCommandContext = {
  args: CommandArgs
  db: DB
  cwd: string
  write?: (s: string) => void
}

async function runTrustCommand(ctx: TrustCommandContext): Promise<void> {
  const write = ctx.write ?? ((s: string) => process.stdout.write(s))
  const dir = ctx.args.positionals[0] ?? ctx.cwd
  const project = await fromDirectory(ctx.db, dir)
  await trustProject(ctx.db, project.id)
  write(
    `已信任项目「${project.name ?? project.worktree}」（${project.worktree}）。\n` +
      `该项目作用域配置（.c0de/config.json）生效，项目插件在下次启动时加载。\n`,
  )
}

export type { TrustCommandContext }
export { runTrustCommand }
