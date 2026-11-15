// BroadcastChannel 跨标签页「广播 + 订阅」骨架的单一实现。此前 chatState（run
// 状态）与 permission（授权模式）各持一份逐字同构副本（SSR 守卫 + try/catch +
// 用后即关），订阅侧同样两份（onmessage + 返回 close）——收敛于此。共享层只管
// 频道骨架；消息形状与过滤规则（忽略本页广播、按会话过滤等语义）留在各调用方。
//
// 广播端 postMessage 后立即 close：广播不需要长驻频道；订阅端长驻，由返回的
// 取消函数关闭（调用方在 effect 清理时调用）。

/** 向指定频道广播一条消息；SSR/无 BroadcastChannel 时静默跳过（无跨标签页同步）。 */
export function broadcastOnChannel(name: string, msg: unknown): void {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return
  try {
    const ch = new BroadcastChannel(name)
    ch.postMessage(msg)
    ch.close()
  } catch {
    // BroadcastChannel 不可用：忽略（无跨标签页同步）
  }
}

/** 订阅指定频道；SSR/无 BroadcastChannel 时返回 noop。返回取消订阅函数。 */
export function subscribeChannel<T>(name: string, handler: (msg: T) => void): () => void {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return () => {}
  const ch = new BroadcastChannel(name)
  ch.onmessage = (ev: MessageEvent<T>) => handler(ev.data)
  return () => ch.close()
}
