import { css } from '@linaria/core'
import { type RefObject, useCallback, useEffect, useState } from 'react'

export type StickyUser = { id: string; text: string }

/**
 * 浮层高度（px）。既是占位容器的恒定 min-height，也是滚动时判定一条用户消息
 * 「已滚出顶部」的阈值——二者必须一致，否则显示/隐藏切换会改变内容高度、
 * 引发 active 反复横跳的抖动反馈环。
 */
const STICKY_H = 36

const placeholder = css`
  position: sticky;
  top: 0;
  z-index: 5;
  min-height: ${STICKY_H}px;
`

const bar = css`
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: ${STICKY_H}px;
  padding: 0 6px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  border-radius: 0 0 6px 6px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
`

const jump = css`
  flex: 1;
  min-width: 0;
  text-align: left;
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 12px;
  line-height: 1.4;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 4px 2px;
`

const nav = css`
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-secondary);
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  padding: 0;

  &:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--primary);
  }

  &:disabled {
    opacity: 0.35;
    cursor: default;
  }
`

/**
 * 顶部滞留的用户消息浮层。
 *
 * 滚动时把「视口顶部上方最近一条用户消息」钉在聊天流顶部：
 * - 点击文本区或上下箭头 → 平滑滚动到对应消息，且对齐到浮层正下方（完整可见）。
 * - 占位容器恒定占位，杜绝 active 切换的抖动。
 * - active 选取规则：遍历 DOM 中所有 [data-role="user"]，取最后一个 top 已越过
 *   STICKY_H 阈值的；没有（首条用户消息顶部仍在阈值下方）则不显示浮层内容。
 */
export function StickyUserMessage({
  containerRef,
  messages,
}: {
  containerRef: RefObject<HTMLDivElement | null>
  messages: StickyUser[]
}) {
  const [activeIdx, setActiveIdx] = useState(-1)

  const userEls = useCallback((): HTMLElement[] => {
    const container = containerRef.current
    if (!container) return []
    return Array.from(container.querySelectorAll<HTMLElement>('[data-role="user"]'))
  }, [containerRef])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let raf = 0
    const update = () => {
      raf = 0
      const els = userEls()
      if (els.length === 0) {
        setActiveIdx(-1)
        return
      }
      const top = container.getBoundingClientRect().top
      let idx = -1
      for (let i = 0; i < els.length; i++) {
        const el = els[i]
        if (!el) break
        if (el.getBoundingClientRect().top < top + STICKY_H + 1) idx = i
        else break
      }
      setActiveIdx(idx)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    // 消息增减（流式追加 / 历史重载）时重新计算滞留项，无需依赖 messages prop。
    const mo = new MutationObserver(onScroll)
    mo.observe(container, { childList: true, subtree: true })
    update()
    return () => {
      container.removeEventListener('scroll', onScroll)
      mo.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [containerRef, userEls])

  const scrollToIndex = useCallback(
    (i: number) => {
      const container = containerRef.current
      if (!container) return
      const el = userEls()[i]
      if (!el) return
      const cRect = container.getBoundingClientRect()
      const eRect = el.getBoundingClientRect()
      // 对齐到浮层正下方，确保目标消息顶部不被浮层遮挡。
      container.scrollBy({ top: eRect.top - cRect.top - STICKY_H, behavior: 'smooth' })
    },
    [containerRef, userEls],
  )

  const msg = activeIdx >= 0 ? messages[activeIdx] : undefined

  return (
    <div className={placeholder} data-testid="sticky-user-placeholder">
      {msg && (
        <div className={bar} data-testid="sticky-user">
          <button
            type="button"
            className={nav}
            onClick={() => scrollToIndex(activeIdx - 1)}
            disabled={activeIdx <= 0}
            aria-label="上一条用户消息"
            data-testid="sticky-user-prev"
          >
            ↑
          </button>
          <button
            type="button"
            className={jump}
            onClick={() => scrollToIndex(activeIdx)}
            title={msg.text}
            data-testid="sticky-user-jump"
          >
            {msg.text || '(空消息)'}
          </button>
          <button
            type="button"
            className={nav}
            onClick={() => scrollToIndex(activeIdx + 1)}
            disabled={activeIdx >= messages.length - 1}
            aria-label="下一条用户消息"
            data-testid="sticky-user-next"
          >
            ↓
          </button>
        </div>
      )}
    </div>
  )
}
