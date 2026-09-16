// src/cli/commands/sessions.ts — CLI 会话管理（P3：清理 print 模式积累的 CLI 会话）。
//
// c0de chat 每次运行都创建 source='cli' 会话且被 Web 会话树排除，
// 此前无任何 CLI 途径列出/清理，垃圾数据只增不减。
// 复用 withAgentDeps 的持久库生命周期（serve 占用时退化为内存库则明确报错）。
//
// P1 闭环修复：delete 移入回收站后必须有 CLI 恢复途径（此前文案承诺
// 「60 天内可恢复」但 CLI 无 restore 子命令，恢复只能绕道 Web 界面）。

import type { DB } from '../../db/client.js'
import { fromDirectory } from '../../project/project.js'
import {
  emptyTrash,
  getSession,
  listAllSessions,
  listDeletedSessions,
  permanentlyDeleteSession,
  rebindSession,
  restoreSession,
  softDeleteSession,
  touchTrashSeen,
} from '../../session/session.js'
import type { CommandArgs } from '../parser.js'

type SessionsCommandContext = {
  args: CommandArgs
  db: DB
  write?: (s: string) => void
}

async function runSessionsCommand(ctx: SessionsCommandContext): Promise<void> {
  const write = ctx.write ?? ((s: string) => process.stdout.write(s))
  const sub = ctx.args.positionals[0] ?? 'list'

  if (sub === 'list') {
    const sessions = await listAllSessions(ctx.db)
    if (sessions.length === 0) {
      write('无会话。\n')
      return
    }
    for (const s of sessions) {
      const source = s.source === 'cli' ? 'cli' : 'web'
      const when = new Date(s.updatedAt).toISOString()
      write(`- [${source}] ${s.title}  (id: ${s.id}, updated ${when})\n`)
    }
    return
  }

  if (sub === 'delete') {
    const id = ctx.args.positionals[1]
    if (!id) throw new Error('sessions delete: a session id is required (use `c0de sessions list`)')
    const ok = await softDeleteSession(ctx.db, id)
    if (!ok) throw new Error(`sessions delete: session not found or already deleted: ${id}`)
    write(`已删除会话 ${id}（移入回收站，60 天内可用 \`c0de sessions restore ${id}\` 恢复）。\n`)
    return
  }

  if (sub === 'restore') {
    const id = ctx.args.positionals[1]
    if (!id)
      throw new Error('sessions restore: a session id is required (use `c0de sessions list`)')
    const ok = await restoreSession(ctx.db, id)
    if (!ok) throw new Error(`sessions restore: session not found or not deleted: ${id}`)
    // P2-2：与 Web restore 对齐——会话项目已删除（FK set null）时按 worktreePath
    // 重建归属，避免恢复成功但在 Web 各项目视图不可达。
    // P2 修复：--project <path> 提供显式归属出口（Web 有「归属到当前项目」，
    // CLI 此前只有警告、用户自己修不了）。
    const projectPath = ctx.args.options.project as string | undefined
    const session = await getSession(ctx.db, id)
    if (session && !session.projectId && (session.worktreePath || projectPath)) {
      try {
        const { existsSync } = await import('node:fs')
        const target = projectPath ?? session.worktreePath
        if (target && existsSync(target)) {
          const project = await fromDirectory(ctx.db, target)
          await rebindSession(ctx.db, id, project)
          write(`已恢复会话 ${id}（已重新归属到项目 ${project.id}）。\n`)
          return
        }
        if (projectPath) {
          throw new Error(`项目目录不存在：${projectPath}`)
        }
        write(`已恢复会话 ${id}（警告：原项目目录不存在，会话未归属任何项目，Web 不可见）。\n`)
        write(`提示：c0de sessions restore ${id} --project <项目路径> 可显式归属。\n`)
        return
      } catch (error) {
        write(
          `已恢复会话 ${id}（警告：项目归属失败——${error instanceof Error ? error.message : String(error)}，会话可能不可见）。\n`,
        )
        return
      }
    }
    if (session?.projectId && projectPath) {
      write(`已恢复会话 ${id}（会话已有项目归属，忽略 --project）。\n`)
      return
    }
    write(`已恢复会话 ${id}。\n`)
    return
  }

  // 回收站列表：软删除会话 + 剩余保留信息（辅助 restore）。
  // P2：列出即「看到」——CLI-only 用户此前无 Web 回收站可打开，trashSeenAt 永不写入，
  // 60 天保留期永不启动（条目只能等 365 天绝对上限）。此处与 Web 打开分组同口径
  // 标记（仅首次、全量、含孤儿）。
  // --project <path>：把「看到」标记与列表限定到单个项目（与 Web 按项目分组一致）——
  // 缺省全库标记会启动所有项目回收站条目的倒计时，多项目用户应显式限定作用域。
  if (sub === 'deleted') {
    const projectPath = ctx.args.options.project as string | undefined
    let projectId: string | undefined
    if (projectPath) {
      const { existsSync } = await import('node:fs')
      if (!existsSync(projectPath)) {
        throw new Error(`sessions deleted: 项目目录不存在：${projectPath}`)
      }
      projectId = (await fromDirectory(ctx.db, projectPath)).id
    }
    await touchTrashSeen(ctx.db, projectId ? { projectId } : {})
    const sessions = await listDeletedSessions(ctx.db, projectId)
    if (sessions.length === 0) {
      write('回收站为空。\n')
      return
    }
    if (!projectId) {
      write(
        '（全库回收站。多项目用户建议加 --project <路径> 限定作用域：全库「看到」标记会启动所有项目条目的保留期倒计时。）\n',
      )
    }
    for (const s of sessions) {
      const when = s.deletedAt ? new Date(s.deletedAt).toISOString() : '-'
      write(`- ${s.title}  (id: ${s.id}, deleted ${when})\n`)
    }
    return
  }

  // 彻底删除（不可恢复）：purge <id> 单条；purge --all 清空回收站。
  // P2：CLI 回收站闭环——此前 CLI 无永久删除途径，条目只能被动等 purge 任务。
  // 永久操作需 --yes（与 Web 键入确认的「彻底删除/清空回收站」同强度）。
  if (sub === 'purge') {
    const all = ctx.args.options.all === true
    const yes = ctx.args.options.yes === true
    const id = ctx.args.positionals[1]
    if (!all && !id) {
      throw new Error(
        'sessions purge: 需要会话 id（purge <id>）或 --all（清空回收站），两者均不可恢复，需 --yes 确认',
      )
    }
    if (!yes) {
      throw new Error(
        all
          ? 'sessions purge --all 将永久删除回收站全部会话，不可恢复。确认执行请加 --yes。'
          : `sessions purge ${id} 将永久删除该会话及其派生分支，不可恢复。确认执行请加 --yes。`,
      )
    }
    const deleted = all
      ? await emptyTrash(ctx.db)
      : await permanentlyDeleteSession(ctx.db, id ?? '')
    if (all) {
      write(`已清空回收站（永久删除 ${deleted} 个会话）。\n`)
    } else if (deleted > 0) {
      write(`已永久删除会话 ${id}（含 ${deleted - 1} 个派生会话）。\n`)
    } else {
      throw new Error(`sessions purge: 会话不在回收站或不存在：${id}`)
    }
    return
  }

  throw new Error(
    `sessions: unknown subcommand "${sub}" (expected list|delete|restore|deleted|purge)`,
  )
}

export type { SessionsCommandContext }
export { runSessionsCommand }
