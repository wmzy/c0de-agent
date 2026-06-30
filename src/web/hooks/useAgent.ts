import { useCallback, useState } from 'react'
import { agentAPI } from '../services/agent.js'

export function useAgent(sessionId: string) {
  const [busy, setBusy] = useState(false)
  // 暂停态是乐观本地状态：pause()/resume() 成功后翻转，新 sendMessage 前由调用方重置。
  // 后端 agent loop 暂停时 SSE 流仍开（isStreaming 保持 true），故前端需独立 paused 标志。
  const [paused, setPaused] = useState(false)

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }, [])

  return {
    busy,
    paused,
    abort: () => run(() => agentAPI.abort(sessionId)),
    pause: () =>
      run(async () => {
        await agentAPI.pause(sessionId)
        setPaused(true)
      }),
    resume: () =>
      run(async () => {
        await agentAPI.resume(sessionId)
        setPaused(false)
      }),
    /** 新一轮发送前重置暂停态（见 ChatView.handleSend）。 */
    resetPaused: () => setPaused(false),
    steer: (message: string) => run(() => agentAPI.steer(sessionId, message)),
    confirmTool: (toolCallId: string, approved: boolean) =>
      run(() => agentAPI.confirmTool(toolCallId, approved)),
  }
}
