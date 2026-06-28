import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 检测内容是否溢出阈值（像素），并提供展开/收起态。
 * 用法：把 ref 绑到内容容器，用 expanded 控制 max-height（CSS 侧）。
 */
export function useOverflow(threshold = 300) {
  const ref = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setOverflowing(el.scrollHeight > threshold)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [threshold])

  const toggle = useCallback(() => setExpanded((v) => !v), [])
  return { ref, overflowing, expanded, toggle }
}