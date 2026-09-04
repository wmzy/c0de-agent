// src/cli/commands/sessions.ts — CLI 会话管理（P3：清理 print 模式积累的 CLI 会话）。
//
// c0de chat 每次运行都创建 source='cli' 会话且被 Web 会话树排除，
// 此前无任何 CLI 途径列出/清理，垃圾数据只增不减。
// 复用 withAgentDeps 的持久库生命周期（serve 占用时退化为内存库则明确报错）。

import type { DB } from '../../db/client.js'
import { listAllSessions, softDeleteSession } from '../../session/session.js'
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
    write(`已删除会话 ${id}（移入回收站，30 天内可恢复）。\n`)
    return
  }

  throw new Error(`sessions: unknown subcommand "${sub}" (expected list|delete)`)
}

export type { SessionsCommandContext }
export { runSessionsCommand }
