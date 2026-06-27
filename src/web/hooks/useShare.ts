import { useCallback, useState } from 'react'

type ShareData = { title?: string; text?: string; url?: string }

export function useShare() {
  const supported = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  const [shared, setShared] = useState(false)

  const share = useCallback(
    async (data: ShareData) => {
      if (!supported) return false
      try {
        await navigator.share(data)
        setShared(true)
        return true
      } catch {
        return false
      }
    },
    [supported],
  )

  return { supported, share, shared }
}
