import { useCallback, useState } from 'react'

export function usePushNotification() {
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  )

  const requestPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return 'denied' as const
    const p = await Notification.requestPermission()
    setPermission(p)
    return p
  }, [])

  const notify = useCallback((title: string, body?: string) => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    try {
      new Notification(title, { body })
    } catch {
      // Service Worker 注册推送在后续阶段
    }
  }, [])

  return { permission, requestPermission, notify }
}
