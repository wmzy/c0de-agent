import { and, isNotNull, sql } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { sessions } from '../db/schema.js'
import { appendMessage } from './message.js'
import { updateSessionLastRun } from './session.js'

/**
 * 标记崩溃遗留的后台子 agent 任务并通知父会话（P2）。
 *
 * background task 在子 session 上写 lastRun.status='running'（subagent.ts），
 * 完成后置 'completed'。进程崩溃时悬空任务永远停在 'running'，父会话收不到
 * 完成通知（原实现仅内存 jobId，重启即丢）。启动时调用：
 *  - 悬空任务 lastRun 置 'completed'（死任务不再显示 interrupted）；
 *  - 合成一条 state="failed" 通知写入父会话（子 session 已挂 parentId）。
 * 返回标记数量。
 */
export async function markDeadBackgroundJobs(handle: DB): Promise<number> {
  const rows = await handle.db
    .select({
      id: sessions.id,
      parentId: sessions.parentId,
      agentType: sessions.agentType,
    })
    .from(sessions)
    .where(
      and(
        isNotNull(sessions.agentType),
        isNotNull(sessions.parentId),
        sql`${sessions.metadata}->'lastRun'->>'status' = 'running'`,
      ),
    )
  for (const row of rows) {
    await updateSessionLastRun(handle, row.id, {
      status: 'completed',
      agentName: row.agentType ?? undefined,
      startedAt: Date.now(),
    })
    if (row.parentId) {
      const synthetic = `<task id="${row.id}" state="failed">\n<task_error>\n后台任务在服务重启前未完成，已标记为失败（可重新派发）\n</task_error>\n</task>`
      await appendMessage(handle, row.parentId, {
        role: 'user',
        content: [{ _tag: 'text', text: synthetic }],
      }).catch(() => {
        // 通知写入失败：任务已标记，父会话可能收不到失败提示——仅记录
      })
    }
  }
  return rows.length
}
