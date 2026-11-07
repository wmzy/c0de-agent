// 值防抖——同一份「setTimeout(delay) 落地 + cleanup 清定时器」效果曾在
// FileBrowser（文件搜索）与 SessionList/RecycleBin（会话内容搜索，经
// useSessionContentSearch）各持一份 4 行副本，收敛于此。
import { useEffect, useState } from 'react'

/**
 * 返回 [防抖值, 立即写入]：value 连续变化时只有最后一次在 delay 后落地。
 * 第二个元素与 useState 的 setter 同形，用于**跳过防抖窗口**的立即复位——
 * 切项目时旧查询词若等满 300ms 才清，防抖窗口内它会带着新 projectId 再发
 * 一次查询（FileBrowser / SessionList 的切项目复位都依赖这一点）。
 */
export function useDebouncedValue<T>(value: T, delayMs: number): [T, (v: T) => void] {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return [debounced, setDebounced]
}
