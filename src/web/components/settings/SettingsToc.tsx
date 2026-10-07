// src/web/components/settings/SettingsToc.tsx
// 设置页的分区导航（TOC）：一行可横滑的分区锚点。
//
// 设置页是全应用最长的一页——实测 GUI 模式 scrollHeight 3369px / 18 个 h2 分区，
// 移动端更达 3898px。原先找「用量与成本」「Web 搜索」只能一路滚到底（约 3 屏），
// 页面本身没有任何分区内导航。?section= 深链只解决「从别处跳进来」，解决不了
// 「已经在这页、想换个分区」。
//
// 用「横滑一行」而非竖排侧栏：主区宽度被 Workbench 三栏分掉，竖排目录会再吃
// 一列宽度、把表单压窄；一行 chip 流则与内容同宽、窄屏自动横滑。
//
// 分区清单不写死在组件里：从 DOM 里的 h2 实测得出，改为日后新增分区时不必
// 回来补两处清单（漏一处就是「导航里没有这一项」的死角）。

import { css } from '@linaria/core'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  GAP,
  measureSettingsSticky,
  notifyTocReady,
  type SettingsSticky,
  scrollSettingsSectionIntoView,
  stickyTotal,
} from '@/components/settings/sectionScroll.js'
import { MOBILE } from '@/styles/breakpoints.js'

const tocBar = css`
  position: sticky;
  z-index: 9;
  display: flex;
  gap: 6px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg);
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
  ${MOBILE} {
    padding: 6px 12px;
  }
`

const tocChip = css`
  flex-shrink: 0;
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--haze-color-border);
  border-radius: 999px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  /* 当前所在分区：primary 描边 + primary 文字 + 淡底，与未激活双重区分 */
  &[aria-current='true'] {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-primary);
    background: color-mix(in srgb, var(--haze-color-primary) 8%, var(--haze-color-bg));
  }
`

/** 渐隐提示宽度；也用作「chip 算不算可见」的余量。 */
const FADE = 24

/**
 * 溢出侧的渐隐遮罩。只在真有内容被遮住的那一侧淡出，否则等于谎报「后面还有」。
 * 两侧同时溢出时用一条两端透明的渐变——mask-image 只有一个属性位，两个方向
 * 必须合并且不能互相覆盖。
 */
function edgeMask(start: boolean, end: boolean): string | undefined {
  if (!start && !end) return undefined
  if (start && end) {
    return `linear-gradient(to right, transparent 0, #000 ${FADE}px, #000 calc(100% - ${FADE}px), transparent 100%)`
  }
  return start
    ? `linear-gradient(to right, transparent 0, #000 ${FADE}px)`
    : `linear-gradient(to left, transparent 0, #000 ${FADE}px)`
}

/**
 * 分区标题的稳定标识。
 *
 * h2 文本里有空格与斜杠（「默认 Provider / Model」「工具指标」），直接拿它当
 * 锚点会得到带空格的 id，且重名时撞车。取序号前缀保证唯一、可读、可直接写进
 * ?section= 深链。
 */
function sectionId(index: number, title: string): string {
  return `section-${index}-${title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}`
}

/**
 * 分区导航。挂载后扫描表单子树的 h2 建立清单，并跟随滚动高亮当前分区。
 *
 * 两条容易踩的坑，这里都按「实测而非写死」处理：
 *
 * 1. sticky 偏移量。目录行要贴在工具条下沿，而工具条高度随内容换行而变
 *    （实测 1440px 下 51px，窄屏换行后更高）。写死 top:45px 会让目录行
 *    盖在工具条底边 6px 上。这里从工具条实测高度写进 style。
 *
 * 2. 分区位置。h2 分散在多个面板组件里，嵌套深度各不相同，
 *    offsetTop 是相对各自父元素的——直接拿来比较会算出「多 Agent」这类
 *    完全错位的当前项。这里一律用 getBoundingClientRect() 的视口坐标。
 */
export function SettingsToc() {
  const [items, setItems] = useState<{ id: string; title: string }[]>([])
  const [active, setActive] = useState<string | null>(null)
  const barRef = useRef<HTMLElement>(null)
  // 工具条/目录行实测高度；写死会随工具条换行而错位。与 ?section= 深链共用
  // measureSettingsSticky，保证「点目录」和「从别处深链进来」落在同一位置。
  const [sticky, setSticky] = useState<SettingsSticky>({ toolbar: 0, toc: 0 })
  // 哪一侧还有被遮住的 chip：驱动渐隐提示，也告诉用户这一行能横滑。
  const [edges, setEdges] = useState({ start: false, end: false })

  // 扫描：只取 GUI 表单子树里的 h2。JSON 视图没有分区（整块是一个编辑器），
  // 扫整个设置页会把别的分支的标题也算进来。
  //
  // 持续观察子树而不只扫一次：配置到达前 UsagePanel 等分区尚未挂载，只在 mount
  // 扫一轮的话目录里会永远缺这几项（实测 18 个分区里少了最后几个）。MutationObserver
  // 监听 h2 的增删，标题集合真的变了才重算，避免每次输入都产生新数组对象（那会让
  // 下面三个依赖 items 的 effect 跟着重跑）。
  useEffect(() => {
    const root = document.querySelector('[data-testid="settings-form"]')
    if (!root) return
    const scan = () => {
      const headings = [...root.querySelectorAll('h2')].filter((h) => h.textContent?.trim())
      const next = headings.map((h, i) => {
        const title = (h.textContent ?? '').trim()
        const id = sectionId(i, title)
        h.id ||= id
        return { id, title }
      })
      setItems((prev) => {
        if (prev.length === next.length && prev.every((p, i) => p.id === next[i]?.id)) return prev
        return next
      })
    }
    scan()
    const mo = new MutationObserver(scan)
    mo.observe(root, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [])

  // 实测 sticky 偏移：工具条高度 + 目录行高度。两者都随内容变化（工具条会
  // 在窄屏换行，目录行高度随内边距），写死常量必错。
  //
  // 用 useLayoutEffect 而非 useEffect：初始 sticky 为 0，若等 paint 之后
  // 才量，目录行会在第一帧贴在顶栏底下（被 z-index 更高的工具栏盖住），
  // 下一帧再跳到正确位置——肉眼是可见的抖动。
  useLayoutEffect(() => {
    if (items.length === 0) return
    const measure = () => {
      setSticky(measureSettingsSticky())
      // 目录行首次出现后广播一次：深链 effect 与本组件的扫描 effect 同批跑，
      // 那时目录行尚未入 DOM，实测高度为 0，订阅方需在就绪后重算落点。
      notifyTocReady()
    }
    measure()
    const ro = new ResizeObserver(measure)
    const toolbar = document.querySelector('[data-testid="settings-toolbar"]')
    if (toolbar) ro.observe(toolbar)
    if (barRef.current) ro.observe(barRef.current)
    return () => ro.disconnect()
  }, [items])

  // 滚动跟随：取「工具条下沿 + 目录行下沿」这条参考线所处的分区。
  // 滚动容器是 <main>（.haze-Workbench__editor），与 Settings 深链 effect 同一口径。
  useEffect(() => {
    if (items.length === 0) return
    const scroller = document.querySelector('.haze-Workbench__editor')
    if (!scroller) return

    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        // 滚到底时直接认定最后一个分区。末段分区（「用量与成本」正是用户最常
        // 去的一个）后面没有内容可撑，滚到底也顶不到参考线上方——实测点击它
        // 后 scrollTop 被钳在 2558，标题停在 y=566，而参考线在 143，按「最后
        // 一个过线者」会高亮成上一节「安全」。此时整屏可见的就是末尾几节，
        // 末节即当前节。
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
          const last = items[items.length - 1]
          if (last) setActive(last.id)
          return
        }
        const line = scroller.getBoundingClientRect().top + stickyTotal(sticky) + GAP
        let current = items[0]?.id
        if (!current) return
        for (const { id } of items) {
          const el = document.getElementById(id)
          if (el && el.getBoundingClientRect().top <= line) current = id
        }
        setActive(current)
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', onScroll)
    }
  }, [items, sticky])

  // 横向溢出提示。18 个分区在 1440px 下已溢出（实测 scrollWidth 1467 >
  // clientWidth 1440），末节「用量与成本」的 chip 右缘被截掉 11px。没有渐隐
  // 提示时，用户看不出这一行还能横滑，只会认为分区就这么多。
  //
  // biome-ignore lint/correctness/useExhaustiveDependencies: items 仅作重测触发
  useEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const measure = () => {
      const max = bar.scrollWidth - bar.clientWidth
      setEdges({ start: bar.scrollLeft > 1, end: max > 1 && bar.scrollLeft < max - 1 })
    }
    measure()
    bar.addEventListener('scroll', measure, { passive: true })
    // 分区数量变化会改 scrollWidth（chip 总宽随之变），而 ResizeObserver 只
    // 报元素自身尺寸变化，不含子元素排布，故仍需 items 触发重测。
    const ro = new ResizeObserver(measure)
    ro.observe(bar)
    return () => {
      bar.removeEventListener('scroll', measure)
      ro.disconnect()
    }
  }, [items])

  // 当前分区的 chip 必须可见：滚到底部时 scroll-spy 把 active 设成第 18 节，
  // 而它本来就在视口外（实测 chip 右缘 1451 > 目录行右缘 1440），用户看不到
  // 「我现在在哪一节」。只动目录行自身的 scrollLeft，不碰页面滚动位置。
  useEffect(() => {
    const bar = barRef.current
    if (!bar || !active) return
    const chip = bar.querySelector<HTMLElement>('[aria-current="true"]')
    if (!chip) return
    const barRect = bar.getBoundingClientRect()
    const chipRect = chip.getBoundingClientRect()
    // 两侧各留出渐隐宽度，chip 才不会停在半透明区里。
    const pad = FADE + 4
    if (chipRect.left < barRect.left + pad) {
      bar.scrollLeft -= barRect.left + pad - chipRect.left
    } else if (chipRect.right > barRect.right - pad) {
      bar.scrollLeft += chipRect.right - (barRect.right - pad)
    }
  }, [active])

  const jump = useCallback((id: string) => {
    const target = document.getElementById(id)
    if (!target) return
    scrollSettingsSectionIntoView(target)
    setActive(id)
  }, [])

  if (items.length === 0) return null

  const mask = edgeMask(edges.start, edges.end)

  return (
    <nav
      ref={barRef}
      className={tocBar}
      style={{ top: sticky.toolbar, maskImage: mask, WebkitMaskImage: mask }}
      data-testid="settings-toc"
      aria-label="设置分区导航"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={tocChip}
          aria-current={active === item.id ? 'true' : undefined}
          onClick={() => jump(item.id)}
          data-testid={`settings-toc-${item.id}`}
        >
          {item.title}
        </button>
      ))}
    </nav>
  )
}
