// src/cli/commands/trust.ts — 显式信任项目（P0-2 信任边界）。
//
// c0de trust [目录] [--yes]：把目录解析/注册为项目并落盘 trustedAt。
// 未信任项目携带风险配置时 Web 聊天入口被 409 门禁拦截；项目 .c0de/plugins
// 在未信任时不加载。本命令是无 Web 场景（headless/CI 前手工审查过仓库）的信任途径。
// P1：信任前展示即将接受的风险清单（项目风险 + 全局权限风险上下文），有风险时
// 必须 --yes 显式确认——Web 信任弹窗逐项明示，CLI 不得盲信任。
// 与 sessions 命令同约束：需要持久库，serve 运行期间报错引导走 Web 界面。

import { loadConfigScopes } from '../../core/config.js'
import type { DB } from '../../db/client.js'
import { fromDirectory, trustProject } from '../../project/project.js'
import { enrichProjectRiskWithGlobal, summarizeProjectRisk } from '../../project/trust.js'
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
  const yes = ctx.args.options.yes === true

  // 信任前明示即将接受的风险（与 Web 信任弹窗同口径：项目风险 + 全局权限风险上下文）。
  const scopes = loadConfigScopes(dir)
  const risks = enrichProjectRiskWithGlobal(summarizeProjectRisk(scopes.project), scopes.global)
  if (risks.length > 0 && !yes) {
    const lines = risks.map((r) => `  - ${r.kind}: ${r.detail}`).join('\n')
    throw new Error(
      `信任「${dir}」将接受以下风险项：\n${lines}\n` +
        `确认已审查无误后执行 c0de trust ${dir !== ctx.cwd ? `${dir} ` : ''}--yes 显式信任。`,
    )
  }

  const project = await fromDirectory(ctx.db, dir)
  await trustProject(ctx.db, project.id)
  const accepted = risks.length > 0 ? `（已确认 ${risks.length} 项风险）` : '（无风险项）'
  write(
    `已信任项目「${project.name ?? project.worktree}」（${project.worktree}）${accepted}。\n` +
      `该项目作用域配置（.c0de/config.json）生效，项目插件在下次启动时加载。\n`,
  )
}

export type { TrustCommandContext }
export { runTrustCommand }
