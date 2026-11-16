import { css } from '@linaria/core'
import { useEffect, useRef, useState } from 'react'

const swipe = css`
  position: relative;
  overflow: hidden;
  touch-action: pan-y;
`

type Props = {
  onDelete?: () => void
  onLongPress?: () => void
  children: React.ReactNode
}

export function TouchListItem({ onDelete, onLongPress, children }: Props) {
  const startX = useRef(0)
  const [dx, setDx] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 卸载清理：长按等待期内行被移除（列表刷新、路由切换）时 touchend 不会再
  // 落到已卸载的元素上，600ms 后的 onLongPress 仍会触发——对着已消失行的回调。
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  return (
    <div
      className={swipe}
      style={{
        transform: `translateX(${dx}px)`,
        transition: dx === 0 ? 'transform 0.2s' : 'none',
      }}
      onTouchStart={(e) => {
        startX.current = e.touches[0]?.clientX ?? 0
        if (onLongPress) timer.current = setTimeout(onLongPress, 600)
      }}
      onTouchMove={(e) => {
        const x = e.touches[0]?.clientX ?? 0
        setDx(Math.min(0, x - startX.current))
        if (timer.current && Math.abs(x - startX.current) > 10) clearTimeout(timer.current)
      }}
      onTouchEnd={() => {
        if (timer.current) clearTimeout(timer.current)
        if (dx < -80) onDelete?.()
        setDx(0)
      }}
      // 取消（系统手势接管、来电打断等）不是用户松手：只做与 onTouchEnd 相同的
      // 复位腿（清 timer、dx 归零），不走删除判定。
      onTouchCancel={() => {
        if (timer.current) clearTimeout(timer.current)
        setDx(0)
      }}
      data-testid="touch-item"
    >
      {children}
    </div>
  )
}
