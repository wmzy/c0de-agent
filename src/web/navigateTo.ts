// 命令式导航的类型化收口（painless navigateTo 同构移植）：
// TypedLink 的命令式侧对应物。声明式侧 to 收窄到 AppPaths 字面量联合、
// 动态段强制 params；此前命令式调用点是运行时字符串拼接，路径拼写与
// params 缺失都逃逸到生产运行时。插值与编码同 TypedLink 落点
// （逐值 encodeURIComponent）——「点链接」与「命令式跳转」产生同一 href。

import type { RouterInstance } from '@native-router/core'
import { navigate } from '@native-router/core'
import type { RouteParams } from '@native-router/react'

import type { AppPaths } from '@/routes.js'

type NavigateArgs<P extends AppPaths> =
  Record<never, never> extends RouteParams<P>
    ? [opts?: { search?: string }]
    : [opts: { params: NoInfer<RouteParams<P>>; search?: string }]

// interpolatePath 的本地同构实现：库未导出公共 API。`:name` 取 string、
// `*name` 取 string[]（'/' 连接），逐值 encodeURIComponent；`\` 转义段原样保留；
// 缺失/空值抛错（漏 params 本应是编译错误，这里只兜绕过类型面的调用）。
function interpolatePath(pattern: string, params: Record<string, string | string[]>): string {
  return pattern.replace(/\\.|[:*]([A-Za-z_$][A-Za-z0-9_$]*)/g, (match, name?: string) => {
    if (name === undefined) return match
    const value = params[name]
    if (value === undefined || value.length === 0) {
      throw new Error(`Missing param "${name}" for the path pattern "${pattern}"`)
    }
    return (Array.isArray(value) ? value : [value]).map(encodeURIComponent).join('/')
  })
}

// 目标已有 '?' 用 '&' 续接，否则补 '?'；空/缺省不追加。
function appendSearch(to: string, search: string | undefined): string {
  if (!search) return to
  return `${to}${to.includes('?') ? '&' : '?'}${search}`
}

// fire-and-forget：被取代/取消的导航链 reject NavigationCancelledError，
// 吞掉即「停在旧视图」语义。返回 void：调用点无从 await，rejection 也不会
// 漏进 unhandled 通道。
export function navigateTo<P extends AppPaths>(
  // biome-ignore lint/suspicious/noExplicitAny: 路由实例视图层类型无共享约束，painless 同款
  router: RouterInstance<any>,
  path: P,
  ...args: NavigateArgs<P>
): void {
  const { params, search } = (args[0] ?? {}) as {
    params?: Record<string, string | string[]>
    search?: string
  }
  const href = appendSearch(interpolatePath(path, params ?? {}), search)
  void navigate(router, href).catch(() => undefined)
}
