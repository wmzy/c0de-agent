import { useEffect, useRef, useState } from 'react'
import { assistAPI } from '@/services/assist.js'

type UsePromptPredictionOptions = {
  /** 目标会话；未定（草稿页）时不预测。 */
  sessionId?: string
  /** config.assist.predictionEnabled（默认关）。 */
  enabled: boolean
  /** 输入框为空（ghost 只在空输入时出现，omp 口径）。 */
  isEmpty: boolean
  /** 流式/轮询中不预测（运行中的会话没有「下一步」）。 */
  isStreaming: boolean
  /** 会话已有消息：空会话没有可预测的上下文。 */
  hasMessages: boolean
}

/** 触发去抖：run 刚结束/切到空输入时稍等片刻再请求，过滤「清空后马上又输入」
 *  的往返（请求在途即作废，见 effect 的清理）。 */
const PREDICTION_DEBOUNCE_MS = 800

/**
 * 空输入预测（oh-my-pi composer-prediction 口径）：会话 settled 且输入框空置时
 * 请求一次预测，作为 ghost 文本交给 Composer 渲染。任何失效条件（开始输入/
 *  流式恢复/切会话/关闭）立即清空；采纳或 Esc 由 Composer 回调 clear。
 */
export function usePromptPrediction(options: UsePromptPredictionOptions) {
  const { sessionId, enabled, isEmpty, isStreaming, hasMessages } = options
  const [prediction, setPrediction] = useState<string | null>(null)
  /** 用户显式忽略（Esc）或已采纳的世代号：作废后再触发的请求结果不再显示。 */
  const dismissedGenRef = useRef(0)

  useEffect(() => {
    const active = !!sessionId && enabled && isEmpty && !isStreaming && hasMessages
    if (!active) {
      setPrediction(null)
      return
    }
    const gen = ++dismissedGenRef.current
    const timer = setTimeout(() => {
      assistAPI
        .predictPrompt(sessionId as string)
        .then((res) => {
          if (gen !== dismissedGenRef.current) return
          setPrediction(res.prediction)
        })
        .catch(() => {
          // 预测是纯增强：失败静默（含 assist 未启用时的 404）。
        })
    }, PREDICTION_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      // 依赖变化即作废在途请求的结果；不清 prediction（新一轮 effect 会覆盖/
      // 清空），避免输入第一个字时 ghost 闪断——它已由 isEmpty=false 分支清掉。
    }
  }, [sessionId, enabled, isEmpty, isStreaming, hasMessages])

  /** 采纳/忽略后清空（Composer 的接受与 Esc 分支调用）。 */
  const clear = () => {
    dismissedGenRef.current += 1
    setPrediction(null)
  }

  return { prediction, clearPrediction: clear }
}

export { PREDICTION_DEBOUNCE_MS }
