import { createContext, useContext } from 'react'
import type { ShakeRegionView } from '../../types/index.js'

/**
 * Shake 模式上下文：驱动会话内原地选择。
 *
 * enabled=false 时所有值无意义（组件应 fast-return 正常渲染）。
 * regionsByMessage 按 messageId 索引，MessageItem 查当前消息的可 shake 区域。
 * selected 是已勾选 region id 集合；onToggle 切换某个 region。
 */
export type ShakeModeValue = {
  enabled: boolean
  regionsByMessage: Map<string, ShakeRegionView[]>
  selected: Set<string>
  onToggle: (id: string) => void
}

const ShakeContext = createContext<ShakeModeValue | null>(null)

export const ShakeProvider = ShakeContext.Provider

/** 消费 shake 模式；未启用时返回 null，调用方走正常渲染路径。 */
export function useShakeMode(): ShakeModeValue | null {
  return useContext(ShakeContext)
}
