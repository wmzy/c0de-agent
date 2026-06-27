import { useCallback, useState } from 'react'
import { agentAPI } from '../services/agent.js'

export function useAgent(sessionId: string) {
  const [busy, setBusy] = useState(false)

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
    abort: () => run(() => agentAPI.abort(sessionId)),
    pause: () => run(() => agentAPI.pause(sessionId)),
    resume: () => run(() => agentAPI.resume(sessionId)),
    steer: (message: string) => run(() => agentAPI.steer(sessionId, message)),
    confirmTool: (toolCallId: string, approved: boolean) =>
      run(() => agentAPI.confirmTool(toolCallId, approved)),
  }
}
