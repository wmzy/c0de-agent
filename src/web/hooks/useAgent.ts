import { useCallback, useEffect, useRef, useState } from 'react'
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
  /**
   * 会话世代号。paused/busy/error 描述的都是「**这一条**会话的运行」，而本 hook 的
   * 实例在同 path 换 sessionId 时不会重建（ChatSession 自述），Chat 也不重建——于是
   * 在 A 上点「暂停」失败（或撞上 {paused:false}）后切到 B，A 的「⚠ 没有可暂停的运行」
   * 红条与 paused=true 会整块挂到 B 上：B 的对话在跑，顶栏却写「恢复」，点下去只会拿到
   * 「没有可恢复的运行」。切会话先作废世代并复位，迟到的响应不得写进新会话。
   */
  const genRef = useRef(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId 只是触发条件（切会话即复位），不参与本 effect 的计算
  useEffect(() => {
    genRef.current += 1
    setBusy(false)
    setPaused(false)
    setError(null)
  }, [sessionId])

  const run = useCallback(
    async <T>(fn: (isStale: () => boolean) => Promise<T>): Promise<T | undefined> => {
      const gen = genRef.current
      // 世代不同 = 这次操作属于上一条会话，它的一切落地（失败原因、暂停态、busy）
      // 都不属于当前界面。
      const isStale = () => genRef.current !== gen
      setBusy(true)
      setError(null)
      try {
        return await fn(isStale)
      } catch (e) {
        if (isStale()) return undefined
        const message =
          (e as { message?: string } | null)?.message ?? (e instanceof Error ? e.message : null)
        setError(message || '操作失败，请重试')
        return undefined
      } finally {
        if (!isStale()) setBusy(false)
      }
    },
    [],
  )

  return {
    busy,
    paused,
    /** 控制端点的最近一次失败原因（null 表示无未处理的失败）。 */
    error,
    abort: () => run(() => agentAPI.abort(sessionId)),
    pause: () =>
      run(async (isStale) => {
        const res = await agentAPI.pause(sessionId)
        if (isStale()) return
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
      run(async (isStale) => {
        const res = await agentAPI.resume(sessionId)
        if (isStale()) return false
        if (!res.resumed) {
          setPaused(true)
          setError('没有可恢复的运行——对话可能已经结束或尚未开始')
          return false
        }
        setPaused(false)
        // 调用点据此决定要不要撤下暂停横幅：失败时服务端 run 仍停在暂停点，
        // 撤掉横幅＝界面宣称「在跑」而实际不会继续，且唯一能恢复的入口一起消失。
        return true
      }),
    /** 新一轮发送前重置暂停态（见 ChatView.handleSend）。 */
    resetPaused: () => setPaused(false),
    steer: (message: string) => run(() => agentAPI.steer(sessionId, message)),
    confirmTool: (toolCallId: string, approved: boolean) =>
      run(() => agentAPI.confirmTool(toolCallId, approved)),
  }
}
