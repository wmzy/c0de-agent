import type { DB } from '../db/client.js'
import type { ChatMessage } from '../shared/types/llm.js'
import type { Message } from '../shared/types/message.js'
import { getEntries } from './message.js'
import { getFileSnapshots } from './snapshot.js'
import type { FileSnapshot, SessionEntry } from './types.js'

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

  return injectSnapshots(messages, snapshots)
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

/** Get the full session context: all entries + file snapshots. */
async function getSessionContext(
  handle: DB,
  sessionId: string,
): Promise<{ entries: SessionEntry[]; snapshots: FileSnapshot[] }> {
  const [entries, snapshots] = await Promise.all([
    getEntries(handle, sessionId),
    getFileSnapshots(handle, sessionId),
  ])
  return { entries, snapshots }
}

export { entriesToChatMessages, getSessionContext, injectSnapshots, messageToChatMessage }
