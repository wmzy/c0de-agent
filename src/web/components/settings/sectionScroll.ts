// src/web/components/settings/sectionScroll.ts
// 设置页「把某个分区标题滚到可见」的唯一口径：遮挡量、落点换算、以及
// 目录行渲染完成的握手信号。
//
// 设置页顶部叠着两条 sticky：工具条（z-index 10）与分区目录行（z-index 9）。
// 分区跳转与 ?section= 深链都必须让开这两条，否则标题停在它们底下被完全
// 遮住——标题不可见时用户看到的是「点了但什么都没变」。
//
// 三处踩过的坑，都按「实测而非写死」处理：
//
// 1. 遮挡高度。工具条会在窄屏换行、目录行高度随内边距变化，写死常量必错。
// 2. 滚动坐标。h2 分散在多个面板组件里，offsetTop 相对各自 offsetParent
//    （.haze-Workbench__workbench），拿它跟容器的 scrollTop 相比会算出
//    几近错位的落点；一律用 getBoundingClientRect 的视口坐标求差。
// 3. 滚动容器。内容在 <main>（.haze-Workbench__editor）内滚，文档本身不滚，
//    浏览器原生锚点跳转不会生效，须手动写 scrollTop。

/** 两条 sticky 的实测高度。 */
export interface SettingsSticky {
  /** 工具条高度（换行后变高）。 */
  toolbar: number
  /** 分区目录行高度；JSON 视图没有目录行，为 0。 */
  toc: number
}

/** 两条 sticky 合计遮挡高度。 */
export function stickyTotal(s: SettingsSticky): number {
  return s.toolbar + s.toc
}

/** 两条 sticky 之间的呼吸间隙。 */
export const GAP = 8

/** 目录行实测高度；未挂载为 0。 */
export function measureToc(): number {
  const el = document.querySelector('[data-testid="settings-toc"]')
  return el ? Math.round(el.getBoundingClientRect().height) : 0
}

/** 工具条实测高度；未挂载为 0。 */
export function measureToolbar(): number {
  const el = document.querySelector('[data-testid="settings-toolbar"]')
  return el ? Math.round(el.getBoundingClientRect().height) : 0
}

/** 当前两条 sticky 的实测高度。 */
export function measureSettingsSticky(): SettingsSticky {
  return { toolbar: measureToolbar(), toc: measureToc() }
}

/**
 * 目录行就绪信号：目录行每被测得一次就通知订阅者。
 *
 * 为什么要信号而不是让调用方自己轮询 DOM：目录行是 SettingsToc 扫描完 h2
 * 才渲染的，而深链 effect 与扫描 effect 同批跑——目录行尚未进入 DOM 时
 * 实测高度恒为 0，落点就会少让 45px，标题正好停在目录行底下。实测
 * 「上下文压缩」深链时标题落在 y=104、目录行下沿在 141，标题被完全遮住。
 * 订阅者拿到信号后重跑一次落点计算即可。
 */
const tocListeners = new Set<() => void>()

/** 订阅「目录行已就绪」信号，返回取消订阅函数。 */
export function onTocReady(fn: () => void): () => void {
  tocListeners.add(fn)
  return () => {
    tocListeners.delete(fn)
  }
}

/** 目录行量出非零高度时广播，调用方据此重算落点。 */
export function notifyTocReady(): void {
  for (const fn of tocListeners) fn()
}

/**
 * 把分区标题滚到两条 sticky 之下。
 *
 * 目标不存在时什么都不做（JSON 视图无分区、锚点名写错）。
 * 页面滚到底时 scrollTop 被容器钳住不动——末段分区后面没有内容可撑，
 * 只能停在能看到的位置，这不是本次调用能改变的。
 */
export function scrollSettingsSectionIntoView(target: HTMLElement): void {
  const scroller = target.closest('main') as HTMLElement | null
  const { toolbar, toc } = measureSettingsSticky()
  const line = (scroller?.getBoundingClientRect().top ?? 0) + toolbar + toc + GAP
  // 视口坐标差值 → 容器滚动坐标差值
  const delta = target.getBoundingClientRect().top - line
  if (scroller) scroller.scrollTop += delta
  else window.scrollBy({ top: delta })
}
