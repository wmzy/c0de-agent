// src/web/utils/nav-guard.ts
// 未保存更改的全局导航守卫注册表。
// Settings 页 dirty 时注册守卫（返回提示文案）；程序化 navigate 的调用方
// （MobileNav 等，不经 <a> 点击/popstate）跳转前查询并确认，防草稿静默丢失。

type GuardFn = () => string | null

let guard: GuardFn | null = null

/** 注册守卫（后注册覆盖先注册；返回注销函数）。 */
export function registerNavGuard(fn: GuardFn): () => void {
  guard = fn
  return () => {
    if (guard === fn) guard = null
  }
}

/** 查询守卫：无守卫或返回 null = 放行；返回提示文案 = 需要确认。 */
export function checkNavGuard(): string | null {
  return guard?.() ?? null
}
