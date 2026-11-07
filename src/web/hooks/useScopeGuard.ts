// 作用域世代守卫——「跨会话在飞作废」idiom 的统一实现。
//
// 背景：路由复用的组件/hook 实例（同 path 换 param，子树不重建）里发起的异步操作
// （fetch/SSE/定时器/mutation）在 await 之后写 state 前，必须先确认「发起时的
// 作用域」（会话/项目/草稿作用域）仍是当前作用域——否则 A 会话的在飞响应会写进
// B 的界面（迟到的时间线/弹窗/失败红条）。各处此前手写
// `const gen = genRef.current` + `genRef.current !== gen`，收敛为同一实现。
//
// 两种用法：
// - 值模式：`useScopeGuard(sessionId)`。scope 值变（Object.is）即**渲染期**自增
//   世代（与本仓 `sessionIdRef.current = sessionId` 渲染期镜像同风格）；scope 允许
//   为 undefined（如 useComposer 的 draftScope），有值 ↔ undefined 的切换同样算变。
//   适用于原站点「effect 体里按 scope 变化递增」的情形。
// - 手动模式：`useScopeGuard()`。不追踪任何值、不自动递增，递增时机完全由调用方
//   掌握（invalidate()）——原站点在回调起点/effect 清理里递增的（useChat 的会话
//   复位 effect、useTerminal 的 runRestore 起点、Chat 的订阅 effect 清理），用
//   手动模式逐点保留原时机。
//
// 在飞操作在**发起时**用 token() 刻号，落地时用 stale(t) 判定是否已过期。
import { useMemo, useRef } from 'react'

export type ScopeGuard = {
  /** 当前世代号：异步操作发起时捕获。 */
  token: () => number
  /** 捕获的世代是否已过期（期间 scope 变过或调用过 invalidate）。 */
  stale: (t: number) => boolean
  /** 手动作废当前世代（回调起点递增、显式丢弃等场景）。 */
  invalidate: () => void
}

export function useScopeGuard(): ScopeGuard
export function useScopeGuard<T>(scope: T): ScopeGuard
export function useScopeGuard<T>(...args: [scope?: T]): ScopeGuard {
  const genRef = useRef(0)
  // 首次观测只播种 prev（不算「变化」、不递增）；此后 scope 值变（Object.is，与
  // React 依赖比较同口径）即渲染期自增。手动模式（未传 scope 实参）完全不追踪。
  const prevRef = useRef<{ has: boolean; value: T | undefined }>({ has: false, value: undefined })
  if (args.length > 0) {
    const scope = args[0]
    const prev = prevRef.current
    if (!prev.has) {
      prevRef.current = { has: true, value: scope }
    } else if (!Object.is(prev.value, scope)) {
      prevRef.current = { has: true, value: scope }
      genRef.current += 1
    }
  }
  return useMemo(
    () => ({
      token: () => genRef.current,
      stale: (t: number) => genRef.current !== t,
      invalidate: () => {
        genRef.current += 1
      },
    }),
    [],
  )
}
