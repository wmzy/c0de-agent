import { css } from '@linaria/core'
import { useState } from 'react'
import { CallRow, SegmentHeader } from '../LLMDetail.js'
import { MessageItem } from './MessageItem.js'
import { isEmptyMessage, type TimelineRow } from './utils/timeline.js'

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

/** 行稳定 key（加前缀避免跨 kind 的 id 碰撞）。 */
function rowKey(row: TimelineRow): string {
  switch (row.kind) {
    case 'message':
      return `m:${row.message.id}`
    case 'call':
      return `c:${row.call.id}`
    case 'segment':
      return `s:${row.segment.id}`
  }
}

/** 行的原始 JSON 文本。 */
function rowJSON(row: TimelineRow): string {
  switch (row.kind) {
    case 'message':
      return JSON.stringify(row.message, null, 2)
    case 'call':
      return JSON.stringify(row.call, null, 2)
    case 'segment':
      return JSON.stringify(row.segment, null, 2)
  }
}

/** 美化态行渲染。 */
function PrettyRow({ row }: { row: TimelineRow }) {
  switch (row.kind) {
    case 'message':
      return <MessageItem message={row.message} />
    case 'call': {
      const idx = row.segment.calls.findIndex((c) => c.id === row.call.id) + 1
      return <CallRow call={row.call} index={idx} />
    }
    case 'segment':
      return <SegmentHeader segment={row.segment} />
  }
}

/**
 * 时间线聊天视图：按位置渲染 buildTimeline 产出的行。
 * - message 行：美化卡片（MessageItem）；空 content 默认隐藏（showAllJson 时露出）。
 * - call 行：复用 CallRow 紧凑摘要（默认折叠，不与消息文本重复）。
 * - segment 行：复用 SegmentHeader 段标记。
 * 每行右上角局部 { } 切换原始 JSON；showAllJson 全局强制 JSON。
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

  return (
    <>
      {rows.map((row) => {
        const key = rowKey(row)
        const isJson = showAllJson || localJson.has(key)
        // 空 content 消息：仅在 JSON 模式下露出（否则美化态无内容可显示）。
        if (row.kind === 'message' && isEmptyMessage(row.message) && !isJson) return null
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
            {isJson ? <pre className={pre}>{rowJSON(row)}</pre> : <PrettyRow row={row} />}
          </div>
        )
      })}
    </>
  )
}
