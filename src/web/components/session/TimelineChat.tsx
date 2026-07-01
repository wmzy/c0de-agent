import { css } from '@linaria/core'
import { useState } from 'react'
import { SegmentBreak, SegmentFooter } from '../LLMDetail.js'
import { MessageItem } from './MessageItem.js'
import { groupBySegment, isEmptyMessage, type TimelineRow } from './utils/timeline.js'

const groupWrap = css`
  position: relative;
`

const rowWrap = css`
  position: relative;
  padding: 2px 0;
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

/**
 * 时间线聊天视图：按段分组渲染。
 * - 每段：非首段 trigger≠initial 时渲染 SegmentBreak → 段内消息 → SegmentFooter。
 * - call 行不渲染（groupBySegment 已滤除）。
 * - 每条消息右上角局部 { } 切换原始 JSON（仅序列化该消息自身）。
 * - showAllJson 全局强制 JSON。
 */
export function TimelineChat({ rows, showAllJson }: { rows: TimelineRow[]; showAllJson: boolean }) {
  const [localJson, setLocalJson] = useState<Set<string>>(new Set())

  const toggle = (key: string) =>
    setLocalJson((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const groups = groupBySegment(rows)

  return (
    <>
      {groups.map((g) => {
        const hasSegmentData = g.segment.id !== '__implicit__'
        return (
          <div className={groupWrap} key={g.segment.id}>
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
          </div>
        )
      })}
    </>
  )
}
