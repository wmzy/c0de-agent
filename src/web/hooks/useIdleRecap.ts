import { useEffect, useRef, useState } from 'react'
import { assistAPI } from '@/services/assist.js'

type UseIdleRecapOptions = {
  sessionId?: string
  /** config.assist.recapEnabled（默认关）。 */
  enabled: boolean
  /** 自 run 结束起算的空闲秒数（config.assist.recapIdleSeconds，默认 240）。 */
  idleSeconds: number
  /** 流式中不计时（空闲起点=流式结束）。 */
  isStreaming: boolean
  /** 会话已有消息：空会话没有可回顾的内容。 */
  hasMessages: boolean
  /** 用户正在输入 = 未离开，不触发；计时重置。 */
  composerEmpty: boolean
}

/**
 * 离场回顾（oh-my-pi idle-recap 口径）：会话 settled 且页面空闲（未流式、输入
 * 框空置=无输入活动）持续 idleSeconds 后请求一次回顾，渲染为时间线底部的灰色
 * 行。触发后按会话+消息锚点记住（服务端 metadata.lastRecap 幂等缓存），同一
 * 状态不会重复计费。流式恢复/用户输入/切会话即隐藏并重置计时。
 */
export function useIdleRecap(options: UseIdleRecapOptions) {
  const { sessionId, enabled, idleSeconds, isStreaming, hasMessages, composerEmpty } = options
  const [recap, setRecap] = useState<string | null>(null)
  /** 已触发过回顾的会话：同一会话只触发一次（新消息由服务端锚点判定，但前端
   *  不再主动重复请求——刷新/重进时才重新拉取一次缓存）。 */
  const triggeredForRef = useRef<string | null>(null)
  /** 世代号（照 usePromptPrediction 的 dismissedGen 口径）：effect 依赖变化
   *  （开始输入/恢复流式/切会话）即作废在途 recap 的结果——旧请求 resolve 后
   *  不得回写已被 setRecap(null) 清掉的回顾行。 */
  const genRef = useRef(0)

  useEffect(() => {
    const gen = ++genRef.current
    const active = !!sessionId && enabled && hasMessages && !isStreaming && composerEmpty
    if (!active) {
      setRecap(null)
      return
    }
    if (triggeredForRef.current === sessionId) return
    const timer = setTimeout(() => {
      triggeredForRef.current = sessionId ?? null
      assistAPI
        .recap(sessionId as string)
        .then((res) => {
          if (gen !== genRef.current) return
          setRecap(res.recap)
        })
        .catch(() => {
          // 回顾失败静默；本会话不再重试（避免反复计费）。
        })
    }, Math.max(1, idleSeconds) * 1000)
    return () => clearTimeout(timer)
  }, [sessionId, enabled, idleSeconds, isStreaming, hasMessages, composerEmpty])

  return { recap }
}

export type { UseIdleRecapOptions }
