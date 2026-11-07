// localStorage / sessionStorage 安全访问（单一入口）。
//
// 浏览器在「站点数据被禁 / 隐私模式 / 沙箱 iframe」下，**访问 localStorage
// 属性本身**即抛 SecurityError（不只写入），配额耗尽时 setItem 抛
// QuotaExceededError。此前各调用点自行 try/catch 或干脆裸调：
//   - 裸调的读点位于 useState 初始化器（渲染路径）——存储被禁时整棵组件树
//     抛错白屏，而不是退化成「无持久化」；
//   - 裸调的写点在事件/effect 里抛错，同样击穿错误边界。
// 收敛到本模块：存储不可用一律降级（读返回 null、写/删静默失败），
// 调用方不再需要各自兜底。sessionGet/sessionSet/sessionRemove 是
// sessionStorage 的同语义变体（会话级镜像与一次性标记，如
// sessionMirror 工厂、首设备注册确认条）。

/** 读取；存储不可用返回 null。 */
export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** 写入；存储不可用（被禁/配额）静默失败，本次会话内不持久化。 */
export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 降级：仅本次会话内生效
  }
}

/** 删除；存储不可用静默失败。 */
export function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // 降级：无持久化
  }
}

/** 读 sessionStorage；存储不可用返回 null。 */
export function sessionGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

/** 写 sessionStorage；存储不可用（被禁/配额）静默失败。 */
export function sessionSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    // 降级：仅本次内存传递
  }
}

/** 删除 sessionStorage 键；存储不可用静默失败。 */
export function sessionRemove(key: string): void {
  try {
    sessionStorage.removeItem(key)
  } catch {
    // 降级：无持久化
  }
}
