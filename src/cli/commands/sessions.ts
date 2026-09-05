// src/cli/commands/sessions.ts — CLI 会话管理（P3：清理 print 模式积累的 CLI 会话）。
//
// c0de chat 每次运行都创建 source='cli' 会话且被 Web 会话树排除，
// 此前无任何 CLI 途径列出/清理，垃圾数据只增不减。
// 复用 withAgentDeps 的持久库生命周期（serve 占用时退化为内存库则明确报错）。
//
// P1 闭环修复：delete 移入回收站后必须有 CLI 恢复途径（此前文案承诺
// 「30 天内可恢复」但 CLI 无 restore 子命令，恢复只能绕道 Web 界面）。

import type { DB } from '../../db/client.js'
import {
  listAllSessions,
  listDeletedSessions,
  restoreSession,
  softDeleteSession,
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
    write(`已删除会话 ${id}（移入回收站，30 天内可用 \`c0de sessions restore ${id}\` 恢复）。\n`)
    return
  }

  if (sub === 'restore') {
    const id = ctx.args.positionals[1]
    if (!id)
      throw new Error('sessions restore: a session id is required (use `c0de sessions list`)')
    const ok = await restoreSession(ctx.db, id)
    if (!ok) throw new Error(`sessions restore: session not found or not deleted: ${id}`)
    write(`已恢复会话 ${id}。\n`)
    return
  }

  // 回收站列表：软删除会话 + 剩余保留信息（辅助 restore）
  if (sub === 'deleted') {
    const sessions = await listDeletedSessions(ctx.db)
    if (sessions.length === 0) {
      write('回收站为空。\n')
      return
    }
    for (const s of sessions) {
      const when = s.deletedAt ? new Date(s.deletedAt).toISOString() : '-'
      write(`- ${s.title}  (id: ${s.id}, deleted ${when})\n`)
    }
    return
  }

  throw new Error(`sessions: unknown subcommand "${sub}" (expected list|delete|restore|deleted)`)
}

export type { SessionsCommandContext }
export { runSessionsCommand }
