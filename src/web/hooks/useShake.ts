// 会话「上下文抖动」（Shake）内联模式的状态与交互流。
// 从 ChatSession 拆出：模式开关、区域预览/选择、提交 mutation、
// ShakeProvider 的 context 值——ChatSession 只消费返回值渲染工具栏。

import type { QueryClient } from '@tanstack/react-query'
import { useMutation } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ShakeModeValue } from '@/components/session/ShakeContext.js'
import { sessionAPI } from '@/services/session.js'
import type { Message, ShakeRegionView } from '@/types/index.js'

/** 失败原因取服务端 message（APIError 是结构体）或 Error.message，与 ChatSession 同口径。 */
function shakeFailureMessage(error: unknown, fallback: string): string {
  const direct = (error as { message?: unknown } | null)?.message
  if (typeof direct === 'string' && direct) return direct
  return error instanceof Error && error.message ? error.message : fallback
}

export function useShake(sessionId: string, messages: Message[], qc: QueryClient) {
  // shake 内联模式状态
  const [shakeMode, setShakeMode] = useState(false)
  const [shakeRegions, setShakeRegions] = useState<ShakeRegionView[]>([])
  const [shakeSelected, setShakeSelected] = useState<Set<string>>(new Set())
  /**
   * Shake 失败原因。此前预览走空 catch、提交 mutation 没有 onError：请求失败时
   * 界面与点击前完全一致（预览失败：按钮零反应；提交失败：抖动模式照旧、被选中的
   * 区域没被裁掉），用户唯一的判断是「按钮/功能坏了」，只能反复点。
   */
  const [shakeError, setShakeError] = useState<string | null>(null)
  const shakeMutation = useMutation({
    mutationFn: (regionIds: string[]) => sessionAPI.shakeApply(sessionId, regionIds),
    onSuccess: () => {
      setShakeError(null)
      qc.invalidateQueries({ queryKey: ['session', sessionId, 'messages'] })
      exitShakeMode()
    },
    onError: (error: unknown) => {
      setShakeError(shakeFailureMessage(error, '提交失败，被选中的区域没有裁掉。'))
    },
  })

  const exitShakeMode = () => {
    setShakeMode(false)
    setShakeRegions([])
    setShakeSelected(new Set())
    setShakeError(null)
  }

  const handleShakeOpen = async () => {
    setShakeError(null)
    try {
      const result = await sessionAPI.shakePreview(sessionId)
      setShakeRegions(result.regions)
      setShakeSelected(
        new Set(result.regions.filter((r) => r.isAfterProtectWindow).map((r) => r.id)),
      )
      setShakeMode(true)
    } catch (error) {
      setShakeError(shakeFailureMessage(error, '无法读取可裁剪的区域，Shake 未打开。'))
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

  // 会话级状态必须跟着会话走。ChatSession 在 /projects/:p/sessions/:a → :b 之间被
  // 路由复用（route.path 不变，子树不重建），useState 只在首次挂载初始化一次：
  // 上一条会话打开的 Shake 模式、区域、勾选整块跟到下一条会话。界面上是
  // 「⚡ Shake 模式 · 已选 0/1」而这条会话一个高亮都没有，点「提交 Shake」还会把
  // A 的 region id POST 到 B 的 /shake/apply（实测 400「消息已变化，请重新预览」，
  // 工具栏继续赖着不走）——用户以为 Shake 是这条会话开着的。
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId 只是复位的触发条件，不参与计算
  useEffect(() => {
    setShakeMode(false)
    setShakeRegions([])
    setShakeSelected(new Set())
    setShakeError(null)
  }, [sessionId])

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
    shakeError,
    exitShakeMode,
    handleShakeOpen,
    shakeContextValue,
    shakeSelectedTokens,
  }
}
