import { css } from '@linaria/core'
import { useRef, useState } from 'react'

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
      data-testid="touch-item"
    >
      {children}
    </div>
  )
}
