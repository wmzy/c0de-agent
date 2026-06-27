import { generateId } from '../shared/index.js'
import type { DB } from '../db/client.js'
import type { CompactionResult, SquashConfig, Summarizer } from './types.js'
import { archiveOriginalEntries } from './archive.js'
import { deleteEntriesByIds, getMessages, insertEntry } from './message.js'
import { estimateTokens } from './token.js'
import { upsertFileSnapshot } from './snapshot.js'
import { extractHotFiles } from './compaction.js'

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
    .map((m) => `[${m.role}] ${m.content.map((p) => (p._tag === 'text' ? p.text : JSON.stringify(p))).join(' ')}`)
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
  const archiveId = cfg.archiveOriginal
    ? await archiveOriginalEntries(handle, sessionId, toSquash, 'squash', summary, squashEntryId)
    : generateId()

  const fileSnapshotIds: string[] = []
  if (cfg.preserveFileSnapshots) {
    const hotFiles = extractHotFiles(toSquash)
    for (const file of hotFiles) {
      const id = await upsertFileSnapshot(handle, sessionId, file.path, file.content)
      fileSnapshotIds.push(id)
    }
  }

  await deleteEntriesByIds(handle, toSquash.map((m) => m.id))

  await insertEntry(handle, {
    id: squashEntryId,
    sessionId,
    tag: 'squash',
    content: {
      summary,
      squashedEntryIds: toSquash.map((m) => m.id),
      archiveId,
    },
    tokenCount: estimateTokens(summary),
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
