import type { AgentError, AgentEvent } from '@shared/types/agent.js'
import type { Message, MessageContent } from '@shared/types/message.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { sendChatMessage } from '../services/chat.js'
import type { APIError } from '../types/index.js'
import { generateId } from './id.js'

type ChatState = {
  messages: Message[]
  isStreaming: boolean
  usage: { input: number; output: number } | null
  error: string | null
  pendingPermission: { toolCallId: string; tool: string } | null
}

type ChatOpts = { provider?: string; model?: string; tools?: string[] }

type ChatActions = {
  sendMessage: (content: string, opts?: ChatOpts) => Promise<void>
  abort: () => void
  reset: () => void
}

const INITIAL: ChatState = {
  messages: [],
  isStreaming: false,
  usage: null,
  error: null,
  pendingPermission: null,
}

/** 把 AgentEvent 归约到消息状态。纯函数，可单测。 */
export function reduceChatEvent(state: ChatState, event: AgentEvent): ChatState {
  switch (event._tag) {
    case 'text_delta': {
      const messages = [...state.messages]
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant') {
        const content = [...last.content]
        const lastPart = content[content.length - 1]
        if (lastPart && lastPart._tag === 'text') {
          content[content.length - 1] = { _tag: 'text', text: lastPart.text + event.text }
        } else {
          content.push({ _tag: 'text', text: event.text })
        }
        messages[messages.length - 1] = { ...last, content }
      } else {
        messages.push({
          id: generateId(),
          sessionId: '',
          role: 'assistant',
          content: [{ _tag: 'text', text: event.text }],
          tokenCount: 0,
          createdAt: Date.now(),
        })
      }
      return { ...state, messages }
    }
    case 'thinking': {
      const messages = [...state.messages]
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant') {
        const content = [...last.content]
        const lastPart = content[content.length - 1]
        if (lastPart && lastPart._tag === 'thinking') {
          content[content.length - 1] = { _tag: 'thinking', text: lastPart.text + event.text }
        } else {
          content.push({ _tag: 'thinking', text: event.text })
        }
        messages[messages.length - 1] = { ...last, content }
      } else {
        messages.push({
          id: generateId(),
          sessionId: '',
          role: 'assistant',
          content: [{ _tag: 'thinking', text: event.text }],
          tokenCount: 0,
          createdAt: Date.now(),
        })
      }
      return { ...state, messages }
    }
    case 'tool_call_start': {
      const messages = [...state.messages]
      const last = messages[messages.length - 1]
      const part: MessageContent = {
        _tag: 'tool_call',
        id: event.id,
        tool: event.tool,
        input: event.input,
      }
      if (last && last.role === 'assistant') {
        messages[messages.length - 1] = { ...last, content: [...last.content, part] }
      } else {
        messages.push({
          id: generateId(),
          sessionId: '',
          role: 'assistant',
          content: [part],
          tokenCount: 0,
          createdAt: Date.now(),
        })
      }
      return { ...state, messages }
    }
    case 'tool_call_end': {
      const messages = state.messages.map((m) => {
        if (m.role !== 'assistant') return m
        const hasCall = m.content.some((p) => p._tag === 'tool_call' && p.id === event.id)
        if (!hasCall) return m
        return {
          ...m,
          content: [
            ...m.content,
            {
              _tag: 'tool_result',
              id: event.id,
              tool: '',
              output: event.result,
            } as MessageContent,
          ],
        }
      })
      return { ...state, messages }
    }
    case 'tool_calls_parallel': {
      const messages = [...state.messages]
      const last = messages[messages.length - 1]
      const parts: MessageContent[] = event.calls.map((c) => ({
        _tag: 'tool_call',
        id: c.id,
        tool: c.tool,
        input: c.input,
      }))
      if (last && last.role === 'assistant') {
        messages[messages.length - 1] = { ...last, content: [...last.content, ...parts] }
      }
      return { ...state, messages }
    }
    case 'usage':
      return { ...state, usage: { input: event.input, output: event.output } }
    case 'permission_required':
      return {
        ...state,
        pendingPermission: { toolCallId: event.toolCallId, tool: event.tool },
      }
    case 'error':
      return { ...state, error: errorToMessage(event.error) }
    case 'done':
      return { ...state, isStreaming: false, pendingPermission: null }
    default:
      return state
  }
}

function errorToMessage(err: AgentError): string {
  switch (err._tag) {
    case 'aborted':
      return '已中止'
    case 'max_turns':
      return `达到最大轮数 ${err.maxTurns}`
    case 'unexpected':
      return err.message
    case 'provider':
      return err.message
    case 'tool':
      return `工具 ${err.toolName} 错误: ${err.message}`
  }
}

export function useChat(sessionId: string): ChatState & ChatActions {
  const [state, setState] = useState<ChatState>(INITIAL)
  const abortRef = useRef<AbortController | null>(null)

  // 切换会话时重置本地流式状态；历史消息由调用方合并加载
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅依赖 sessionId 触发重置
  useEffect(() => {
    setState(INITIAL)
  }, [sessionId])

  const sendMessage = useCallback(
    async (content: string, opts?: ChatOpts) => {
      const userMsg: Message = {
        id: generateId(),
        sessionId,
        role: 'user',
        content: [{ _tag: 'text', text: content }],
        tokenCount: 0,
        createdAt: Date.now(),
      }
      // 追加到已有消息（保留历史/多轮），仅重置 usage/error/permission
      setState((s) => ({ ...INITIAL, messages: [...s.messages, userMsg], isStreaming: true }))
      abortRef.current = new AbortController()
      try {
        await sendChatMessage(
          sessionId,
          content,
          (event) => setState((s) => reduceChatEvent(s, event)),
          abortRef.current.signal,
          opts,
        )
      } catch (err) {
        const e = err as unknown as APIError
        setState((s) => ({ ...s, isStreaming: false, error: e.message ?? '发送失败' }))
      }
    },
    [sessionId],
  )

  const abort = useCallback(() => {
    abortRef.current?.abort()
    setState((s) => ({ ...s, isStreaming: false }))
  }, [])

  const reset = useCallback(() => setState(INITIAL), [])

  return { ...state, sendMessage, abort, reset }
}

export type { ChatOpts, ChatState }
