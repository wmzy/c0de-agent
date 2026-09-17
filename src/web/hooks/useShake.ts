// 会话「上下文抖动」（Shake）内联模式的状态与交互流。
// 从 ChatSession 拆出：模式开关、区域预览/选择、提交 mutation、
// ShakeProvider 的 context 值——ChatSession 只消费返回值渲染工具栏。

import type { QueryClient } from '@tanstack/react-query'
import { useMutation } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import type { ShakeModeValue } from '@/components/session/ShakeContext.js'
import { sessionAPI } from '@/services/session.js'
import type { Message, ShakeRegionView } from '@/types/index.js'

export function useShake(sessionId: string, messages: Message[], qc: QueryClient) {
  // shake 内联模式状态
  const [shakeMode, setShakeMode] = useState(false)
  const [shakeRegions, setShakeRegions] = useState<ShakeRegionView[]>([])
  const [shakeSelected, setShakeSelected] = useState<Set<string>>(new Set())
  const shakeMutation = useMutation({
    mutationFn: (regionIds: string[]) => sessionAPI.shakeApply(sessionId, regionIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', sessionId, 'messages'] })
      exitShakeMode()
    },
  })

  const exitShakeMode = () => {
    setShakeMode(false)
    setShakeRegions([])
    setShakeSelected(new Set())
  }

  const handleShakeOpen = async () => {
    try {
      const result = await sessionAPI.shakePreview(sessionId)
      setShakeRegions(result.regions)
      setShakeSelected(
        new Set(result.regions.filter((r) => r.isAfterProtectWindow).map((r) => r.id)),
      )
      setShakeMode(true)
    } catch {
      // 静默失败，不阻塞用户
    }
  }

  const shakeToggle = useCallback((id: string) => {
    setShakeSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const regionsByMessage = useMemo(() => {
    // tool_result 在 DB 中是独立 role:'tool' 消息，前端 mergeToolMessages 合并进 assistant
    // 后该消息被 drop。region.messageId 指向被 drop 的 tool 消息；用 toolCallId 重映射到
    // 含 tool_call 的 assistant 消息，block region 的 messageId 本就是 assistant。
    const callIdToMsgId = new Map<string, string>()
    for (const m of messages) {
      for (const part of m.content) {
        if (part._tag === 'tool_call') callIdToMsgId.set(part.id, m.id)
      }
    }
    const map = new Map<string, ShakeRegionView[]>()
    for (const r of shakeRegions) {
      const targetMsgId =
        r.kind === 'toolResult' && r.toolCallId
          ? (callIdToMsgId.get(r.toolCallId) ?? r.messageId)
          : r.messageId
      const list = map.get(targetMsgId) ?? []
      list.push(r)
      map.set(targetMsgId, list)
    }
    return map
  }, [shakeRegions, messages])

  const shakeContextValue: ShakeModeValue = useMemo(
    () => ({
      enabled: shakeMode,
      regionsByMessage,
      selected: shakeSelected,
      onToggle: shakeToggle,
    }),
    [shakeMode, regionsByMessage, shakeSelected, shakeToggle],
  )

  const shakeSelectedTokens = shakeRegions
    .filter((r) => shakeSelected.has(r.id))
    .reduce((sum, r) => sum + r.tokens, 0)

  return {
    shakeMode,
    shakeRegions,
    shakeSelected,
    setShakeSelected,
    shakeMutation,
    exitShakeMode,
    handleShakeOpen,
    shakeContextValue,
    shakeSelectedTokens,
  }
}
