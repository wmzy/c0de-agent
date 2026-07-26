import { css } from '@linaria/core'
import { useVirtualizer } from '@tanstack/react-virtual'
import { type RefObject, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SegmentBreak, SegmentFooter } from '../LLMDetail.js'
import { MessageItem } from './MessageItem.js'
import {
  groupBySegment,
  isEmptyMessage,
  type SegmentGroup,
  type TimelineRow,
} from './utils/timeline.js'

const virtualInner = css`
  position: relative;
  width: 100%;
`

const virtualItem = css`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
`

const rowWrap = css`
  position: relative;
  padding: 2px 0;
  border-radius: 6px;
  transition: background-color 0.12s ease;

  &:hover {
    background: color-mix(in srgb, var(--bg-secondary) 88%, var(--text) 6%);
  }
`

const jsonToggle = css`
  position: absolute;
  top: 2px;
  right: 0;
  z-index: 1;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  border-radius: 4px;
  padding: 0 6px;
  font-size: 11px;
  cursor: pointer;
  line-height: 18px;

  &:hover {
    color: var(--text);
    border-color: var(--primary);
  }
`

const pre = css`
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  padding: 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 11px;
  max-height: 400px;
  overflow: auto;
`

/** 向上查找最近的可滚动祖先，作为虚拟化的滚动容器（stream 区域）。 */
function useNearestScrollParent<T extends HTMLElement>(
  ref: RefObject<T | null>,
): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    let node = ref.current?.parentElement ?? null
    while (node) {
      const { overflowY } = getComputedStyle(node)
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
        setEl(node)
        return
      }
      node = node.parentElement
    }
  }, [ref])
  return el
}

/**
 * 时间线聊天视图：按段分组渲染。
 * - 每段：非首段 trigger≠initial 时渲染 SegmentBreak → 段内消息 → SegmentFooter。
 * - call 行不渲染（groupBySegment 已滤除）。
 * - 每条消息右上角局部 { } 切换原始 JSON（仅序列化该消息自身）。
 * - showAllJson 全局强制 JSON。
 * - 段组经 useVirtualizer 窗口化渲染，滚动容器复用父级 stream 区域；estimateSize 为
 *   初始估值，measureElement 会按真实高度动态校正。
 */
export function TimelineChat({ rows, showAllJson }: { rows: TimelineRow[]; showAllJson: boolean }) {
  const [localJson, setLocalJson] = useState<Set<string>>(new Set())

  const toggle = useCallback(
    (key: string) =>
      setLocalJson((s) => {
        const next = new Set(s)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      }),
    [],
  )

  const groups = useMemo(() => groupBySegment(rows), [rows])

  const innerRef = useRef<HTMLDivElement>(null)
  const scrollParent = useNearestScrollParent(innerRef)

  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => scrollParent,
    estimateSize: () => 200,
    overscan: 4,
    getItemKey: (i) => groups[i]?.segment.id ?? i,
  })

  /** 渲染单个段组的内部内容（不含定位 wrapper）。 */
  const renderGroupContent = (g: SegmentGroup) => {
    const hasSegmentData = g.segment.id !== '__implicit__'
    return (
      <>
        {hasSegmentData && <SegmentBreak segment={g.segment} />}
        {g.messages.map(({ message, latency }) => {
          const key = `m:${message.id}`
          const isJson = showAllJson || localJson.has(key)
          // 空壳消息：仅在 JSON 模式下露出（否则美化态无内容可显示）。
          if (isEmptyMessage(message) && !isJson) return null
          return (
            <div className={rowWrap} key={key}>
              <button
                type="button"
                className={jsonToggle}
                onClick={() => toggle(key)}
                data-testid={`row-json-${key}`}
                aria-label={isJson ? '切换美化' : '切换 JSON'}
              >
                {isJson ? '✦' : '{ }'}
              </button>
              {isJson ? (
                <pre className={pre}>{JSON.stringify(message, null, 2)}</pre>
              ) : (
                <MessageItem message={message} latency={latency} />
              )}
            </div>
          )
        })}
        {hasSegmentData && <SegmentFooter segment={g.segment} />}
      </>
    )
  }

  // 无滚动容器（测试环境或异常布局）时回退到非虚拟化全量渲染，避免白屏。
  const useVirtual = scrollParent !== null

  return (
    <div
      className={virtualInner}
      ref={innerRef}
      style={useVirtual ? { height: virtualizer.getTotalSize() } : undefined}
    >
      {useVirtual
        ? virtualizer.getVirtualItems().map((vi) => {
            const g = groups[vi.index]
            if (!g) return null
            return (
              <div
                className={virtualItem}
                data-index={vi.index}
                key={g.segment.id}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                {renderGroupContent(g)}
              </div>
            )
          })
        : groups.map((g) => (
            <div className={virtualItem} key={g.segment.id}>
              {renderGroupContent(g)}
            </div>
          ))}
    </div>
  )
}
