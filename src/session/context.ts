import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DB } from '../db/client.js'
import type { ChatMessage, ContentPart } from '../shared/types/llm.js'
import type { Message } from '../shared/types/message.js'
import { getEntries } from './message.js'
import { getFileSnapshots, upsertFileSnapshot } from './snapshot.js'
import type { FileSnapshot, SessionEntry } from './types.js'

/**
 * Drop tool messages whose id cannot be paired with an assistant tool_call,
 * and inject synthetic tool results for orphan tool_calls (assistant 发出了
 * tool_call 但无对应 tool result——服务重启中断场景）。
 *
 * OpenAI Chat 协议要求每个 role=tool 消息必须有 tool_call_id，且必须匹配
 * 前面某条 assistant 消息的 tool_calls[].id。部分输出不规范的 provider
 * 会产生空 id 的 tool_call/tool_result 碎片；这些碎片发回 provider 会触发
 * "invalid tool_call_id"。这里在重建上下文时丢弃：
 *   - assistant.toolCalls 里 id 为空的项（连带丢弃其后无法配对的 tool result）
 *   - role=tool 但 toolCallId 为空、或找不到对应 assistant tool_call 的消息
 * 正常（完整配对）的数据不受影响。
 *
 * 新增：assistant 有有效 tool_call 但后续无匹配 tool result（服务重启中断）时，
 * 注入合成 tool result 告知模型工具被中断，而非丢弃 tool_call 让模型
 * 盲目重试可能已产生副作用的非幂等工具。
 */
function sanitizeToolPairs(messages: ChatMessage[]): ChatMessage[] {
  // 收集所有有效的 assistant tool_call id（非空）
  const validCallIds = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        if (tc.id) validCallIds.add(tc.id)
      }
    }
  }

  // 收集已有 tool result 配对的 tool_call id（用于检测孤儿 tool_call）
  const answeredCallIds = new Set<string>()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId && validCallIds.has(m.toolCallId)) {
      answeredCallIds.add(m.toolCallId)
    }
  }

  const result: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      // 丢弃 id 为空的 tool_call 项；若删空了则整个 toolCalls 移除
      const filtered = m.toolCalls.filter((tc) => tc.id)
      if (filtered.length === 0) {
        result.push({ role: 'assistant', content: m.content })
      } else {
        result.push({ ...m, toolCalls: filtered })
        // 为无 result 配对的 tool_call 注入合成 result（服务中断场景）
        for (const tc of filtered) {
          if (!answeredCallIds.has(tc.id)) {
            result.push({
              role: 'tool',
              toolCallId: tc.id,
              content: JSON.stringify({
                error: 'Tool execution was interrupted by server restart',
              }),
            })
          }
        }
      }
      continue
    }
    if (m.role === 'tool') {
      // toolCallId 为空、或找不到对应 assistant tool_call：丢弃整条 tool 消息
      if (!m.toolCallId || !validCallIds.has(m.toolCallId)) {
        continue
      }
    }
    result.push(m)
  }
  return result
}

/** Convert a stored Message to a protocol-level ChatMessage for the LLM. */
function messageToChatMessage(msg: Message): ChatMessage {
  const textParts = msg.content
    .filter((p) => p._tag === 'text' || p._tag === 'thinking')
    .map((p) => (p._tag === 'thinking' ? `<think>${p.text}</think>` : p.text))
    .join('')

  const toolCalls = msg.content
    .filter((p) => p._tag === 'tool_call')
    .map((p) => ({
      id: p.id,
      name: p.tool,
      arguments: JSON.stringify(p.input),
    }))

  const toolResultPart = msg.content.find((p) => p._tag === 'tool_result')
  const imageParts = msg.content.filter((p) => p._tag === 'image')

  // 含图片：构建多模态 content 数组（text 在前，image 在后）
  if (imageParts.length > 0) {
    const parts: ContentPart[] = []
    if (textParts) parts.push({ type: 'text', text: textParts })
    for (const img of imageParts) {
      if (img._tag !== 'image') continue
      parts.push({ type: 'image', mediaType: img.mediaType, data: img.data })
    }
    const multimodal: ChatMessage = { role: msg.role, content: parts }
    if (toolCalls.length > 0) multimodal.toolCalls = toolCalls
    return multimodal
  }

  // 无图片：保持原纯字符串逻辑（零回归）
  const chat: ChatMessage = {
    role: msg.role,
    content: textParts || (toolResultPart ? JSON.stringify(toolResultPart.output) : ''),
  }

  if (toolCalls.length > 0) {
    chat.toolCalls = toolCalls
  }

  if (toolResultPart && toolResultPart._tag === 'tool_result') {
    chat.toolCallId = toolResultPart.id
    chat.content = JSON.stringify(toolResultPart.output)
  }

  return chat
}

/** Convert all session entries (messages + special) to ChatMessage[] for the LLM. */
function entriesToChatMessages(entries: SessionEntry[], snapshots: FileSnapshot[]): ChatMessage[] {
  const messages: ChatMessage[] = []

  for (const entry of entries) {
    if (!('_tag' in entry)) {
      messages.push(messageToChatMessage(entry))
      continue
    }

    switch (entry._tag) {
      case 'compaction':
      case 'squash':
        messages.push({ role: 'system', content: `[Compacted History]\n${entry.summary}` })
        break
      case 'branch_summary':
        messages.push({ role: 'system', content: `[Branch Context]\n${entry.summary}` })
        break
      case 'steering':
        messages.push({ role: 'system', content: entry.content })
        break
    }
  }

  return injectSnapshots(sanitizeToolPairs(messages), snapshots)
}

/** Inject file snapshot block after the first message (preserves cache prefix). */
function injectSnapshots(messages: ChatMessage[], snapshots: FileSnapshot[]): ChatMessage[] {
  if (snapshots.length === 0) return messages

  // Keep only the highest-version snapshot per filePath (avoid stale duplicates).
  const latestByPath = new Map<string, FileSnapshot>()
  for (const s of snapshots) {
    const prev = latestByPath.get(s.filePath)
    if (!prev || s.version > prev.version) latestByPath.set(s.filePath, s)
  }

  const block = [...latestByPath.values()]
    .map((s) => `[Cached File: ${s.filePath}]\n\`\`\`\n${s.content}\n\`\`\``)
    .join('\n\n')

  const snapshotMessage: ChatMessage = {
    role: 'system',
    content: `[Active File Snapshots — DO NOT re-read these files]\n${block}`,
  }

  if (messages.length === 0) return [snapshotMessage]
  const first = messages[0]
  if (!first) return [snapshotMessage]
  return [first, snapshotMessage, ...messages.slice(1)]
}

/** Get the full session context: all entries + file snapshots.
 *  cwd 提供时刷新过期快照：文件磁盘 mtime 晚于快照记录 → 重读并升版本（P1-5）。 */
async function getSessionContext(
  handle: DB,
  sessionId: string,
  cwd?: string,
): Promise<{ entries: SessionEntry[]; snapshots: FileSnapshot[] }> {
  if (cwd) await refreshStaleSnapshots(handle, sessionId, cwd)
  const [entries, snapshots] = await Promise.all([
    getEntries(handle, sessionId),
    getFileSnapshots(handle, sessionId),
  ])
  return { entries, snapshots }
}

/** 比对每个文件最新快照与磁盘 mtime，过期则重读并写入新版本。 */
async function refreshStaleSnapshots(handle: DB, sessionId: string, cwd: string): Promise<void> {
  const snaps = await getFileSnapshots(handle, sessionId)
  const latest = new Map<string, FileSnapshot>()
  for (const s of snaps) {
    const prev = latest.get(s.filePath)
    if (!prev || s.version > prev.version) latest.set(s.filePath, s)
  }
  for (const s of latest.values()) {
    const p = resolve(cwd, s.filePath)
    // try 只覆盖 fs 错误（stat/readFile）：文件已删除/不可读 → 保留旧快照
    // （读工具会报错提示模型），跳过该文件继续处理其余快照。
    const st = await stat(p).catch(() => null)
    if (!st) continue
    // upsertFileSnapshot 落盘时对 mtimeMs 取整（bigint 列），比对侧同样取整，
    // 避免向下舍入导致"存储值 < 真实值"的永久误判过期。
    if ((s.mtimeMs ?? 0) >= Math.round(st.mtimeMs)) continue
    const content = await readFile(p, 'utf-8').catch(() => null)
    if (content === null) continue
    // DB 写入放在 try 之外：upsertFileSnapshot 失败必须向上抛，
    // 否则过期内容被静默注入上下文（评审 NIT：错误吞没范围过大）。
    await upsertFileSnapshot(handle, sessionId, s.filePath, content, st.mtimeMs)
  }
}

export { entriesToChatMessages, getSessionContext, injectSnapshots, messageToChatMessage }
