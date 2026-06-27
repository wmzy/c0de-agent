import { useCallback, useEffect, useState } from 'react'

type QueuedMsg = { message: string; sessionId: string; timestamp: number }

function load(): QueuedMsg[] {
  try {
    return JSON.parse(localStorage.getItem('c0de-offline-queue') ?? '[]') as QueuedMsg[]
  } catch {
    return []
  }
}

function persist(q: QueuedMsg[]) {
  localStorage.setItem('c0de-offline-queue', JSON.stringify(q))
}

export function useOfflineQueue(send: (sessionId: string, message: string) => Promise<void>) {
  const [online, setOnline] = useState(navigator.onLine)
  const [queue, setQueue] = useState<QueuedMsg[]>(() => load())

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  const enqueue = useCallback((message: string, sessionId: string) => {
    const next = [...load(), { message, sessionId, timestamp: Date.now() }]
    persist(next)
    setQueue(next)
  }, [])

  const flush = useCallback(async () => {
    const pending = load()
    for (const item of pending) {
      await send(item.sessionId, item.message)
    }
    persist([])
    setQueue([])
  }, [send])

  useEffect(() => {
    if (online && queue.length > 0) void flush()
  }, [online, queue.length, flush])

  return { online, enqueue, hasPending: queue.length > 0 }
}
