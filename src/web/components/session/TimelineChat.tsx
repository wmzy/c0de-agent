import { css } from '@linaria/core'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Fragment,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { SegmentBreak, SegmentFooter } from '@/components/LLMDetail.js'
import { MessageItem } from '@/components/session/MessageItem.js'
import {
  groupBySegment,
  isEmptyMessage,
  type SegmentGroup,
  type TimelineRow,
} from '@/components/session/utils/timeline.js'

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

  &:hover > button {
    opacity: 1;
  }
`

/** M3：中断轮次分隔条——半截内容前显式提示，避免与正常对话混淆。 */
const unfinishedDivider = css`
  margin: 6px 0;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border-left: 3px solid var(--warning);
  border-radius: 4px;
`

/** M3：未完成轮次的消息行置灰，弱化「已经发生过」的视觉权重。 */
const unfinishedRow = css`
  opacity: 0.55;
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
  /* 常态半隐降低噪音，悬停消息行或按钮时完整显现 */
  opacity: 0.4;
  transition: opacity 0.12s ease, color 0.12s ease, border-color 0.12s ease;

  &:hover {
    opacity: 1;
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
        {g.messages.map(({ message, latency, unfinished }, idx) => {
          const key = `m:${message.id}`
          const isJson = showAllJson || localJson.has(key)
          const prevUnfinished = idx > 0 ? (g.messages[idx - 1]?.unfinished ?? false) : false
          // M3：未完成轮次（中断 run 的半截回复/工具结果）——置灰 + 首条前插分隔条，
          // 明确告知该内容已从上下文剔除、重发后将被忽略。
          const showDivider = unfinished && !prevUnfinished
          // 空壳消息：仅在 JSON 模式下露出（否则美化态无内容可显示）。
          if (isEmptyMessage(message) && !isJson) return null
          return (
            <Fragment key={key}>
              {showDivider && (
                <div className={unfinishedDivider} data-testid="unfinished-divider">
                  ↻ 未完成轮次：中断前的部分回复与工具结果（已从上下文剔除，不影响重发后的对话）
                </div>
              )}
              <div className={`${rowWrap}${unfinished ? ` ${unfinishedRow}` : ''}`}>
                <button
                  type="button"
                  className={jsonToggle}
                  onClick={() => toggle(key)}
                  data-testid={`row-json-${key}`}
                  aria-label={isJson ? '切换美化' : '切换 JSON'}
                  title={isJson ? '切回美化视图' : '查看该消息原始 JSON'}
                >
                  {isJson ? '✦' : '{ }'}
                </button>
                {isJson ? (
                  <pre className={pre}>{JSON.stringify(message, null, 2)}</pre>
                ) : (
                  <MessageItem message={message} latency={latency} />
                )}
              </div>
            </Fragment>
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
