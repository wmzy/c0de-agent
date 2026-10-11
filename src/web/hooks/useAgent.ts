import { useCallback, useState } from 'react'
import { agentAPI } from '@/services/agent.js'

export function useAgent(sessionId: string) {
  const [busy, setBusy] = useState(false)
  // 暂停态是乐观本地状态：pause()/resume() 成功后翻转，新 sendMessage 前由调用方重置。
  // 后端 agent loop 暂停时 SSE 流仍开（isStreaming 保持 true），故前端需独立 paused 标志。
  const [paused, setPaused] = useState(false)
  // 控制端点（暂停/恢复/中止）的失败原因。此前 run() 只有 try/finally，
  // 请求失败会以未处理 rejection 结束、界面零反馈；且 pause/resume 无视
  // 后端 {paused:false}/{resumed:false}（无活跃 run 时服务端明确返回 false）
  // 也无条件翻转 paused——按钮变成「恢复」而对话仍在消耗 token。
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      const message =
        (e as { message?: string } | null)?.message ?? (e instanceof Error ? e.message : null)
      setError(message || '操作失败，请重试')
    } finally {
      setBusy(false)
    }
  }, [])

  return {
    busy,
    paused,
    /** 控制端点的最近一次失败原因（null 表示无未处理的失败）。 */
    error,
    abort: () => run(() => agentAPI.abort(sessionId)),
    pause: () =>
      run(async () => {
        const res = await agentAPI.pause(sessionId)
        // 服务端 200 ≠ 受理：无活跃 run / 占位期会返回 paused:false
        // （占位期是 409，会被上面的 catch 接住）。
        if (!res.paused) {
          setPaused(false)
          setError('没有可暂停的运行——对话可能已经结束或尚未开始')
          return
        }
        setPaused(true)
      }),
    resume: () =>
      run(async () => {
        const res = await agentAPI.resume(sessionId)
        if (!res.resumed) {
          setPaused(true)
          setError('没有可恢复的运行——对话可能已经结束或尚未开始')
          return
        }
        setPaused(false)
      }),
    /** 新一轮发送前重置暂停态（见 ChatView.handleSend）。 */
    resetPaused: () => setPaused(false),
    steer: (message: string) => run(() => agentAPI.steer(sessionId, message)),
    confirmTool: (toolCallId: string, approved: boolean) =>
      run(() => agentAPI.confirmTool(toolCallId, approved)),
  }
}
