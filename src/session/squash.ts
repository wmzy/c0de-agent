import type { DB } from '../db/client.js'
import { generateId } from '../shared/index.js'
import { rewriteWithSummary } from './compaction.js'
import { getMessages } from './message.js'
import type { CompactionResult, SquashConfig, Summarizer } from './types.js'

const DEFAULT_SQUASH_CONFIG: SquashConfig = {
  keepRecent: 2,
  preserveFileSnapshots: true,
  archiveOriginal: true,
}

/**
 * Squash the most recent `count` messages into a summary, keeping `keepRecent` verbatim.
 * Similar to `git rebase -i + squash`: compresses recent interactions while preserving
 * the conversation prefix and a small tail for cache stability.
 */
async function squashRecent(
  handle: DB,
  sessionId: string,
  count: number,
  summarizer: Summarizer,
  config?: Partial<SquashConfig>,
): Promise<CompactionResult> {
  const cfg = { ...DEFAULT_SQUASH_CONFIG, ...config }
  const messages = await getMessages(handle, sessionId)

  if (messages.length < count + cfg.keepRecent) {
    return { compacted: false, reason: 'too_few_messages' }
  }

  const tailStart = messages.length - cfg.keepRecent
  const squashStart = messages.length - count
  const toSquash = messages.slice(squashStart, tailStart)
  const keepTail = messages.slice(tailStart)

  if (toSquash.length === 0) {
    return { compacted: false, reason: 'nothing_to_compact' }
  }

  const history = toSquash
    .map(
      (m) =>
        `[${m.role}] ${m.content.map((p) => (p._tag === 'text' ? p.text : JSON.stringify(p))).join(' ')}`,
    )
    .join('\n')

  const prompt = `将以下最近的交互压缩为简洁摘要，保留关键决策和上下文，丢弃冗余细节。
重点保留：修改了哪些文件、做了什么决策、当前进度、下一步计划。

## 最近操作
[简要描述做了什么]

## 修改的文件
- path: 变更描述

## 关键决策
[做出的重要决策]

## 当前状态
[进度和下一步]

---
交互历史：
${history}`

  const summary = await summarizer(prompt)

  const squashEntryId = generateId()

  // Atomic rewrite（共享事务体见 compactSession 的 rewriteWithSummary）：
  // archive originals → upsert snapshots → delete originals → insert summary.
  // 任一步抛错整体回滚，原始历史保持完整。archive/snapshot 开关经 cfg 传入。
  const { archiveId, fileSnapshotIds } = await rewriteWithSummary(handle, sessionId, toSquash, {
    entryId: squashEntryId,
    summary,
    tag: 'squash',
    archiveOriginal: cfg.archiveOriginal,
    preserveSnapshots: cfg.preserveFileSnapshots,
    firstKept: keepTail[0],
  })

  return {
    compacted: true,
    summary,
    archiveId,
    fileSnapshots: fileSnapshotIds,
    compactedCount: toSquash.length,
    keptCount: keepTail.length,
  }
}

export { squashRecent }
