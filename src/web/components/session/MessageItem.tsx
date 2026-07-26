import { css } from '@linaria/core'
import type { Message } from '@shared/types/message.js'
import { memo, type ReactNode } from 'react'
import type { ShakeRegionView } from '../../types/index.js'
import { AssistantTextBlock } from './AssistantTextBlock.js'
import { PartDecoration } from './PartDecoration.js'
import { ReasoningBlock } from './ReasoningBlock.js'
import { useShakeMode } from './ShakeContext.js'
import { ToolBlock } from './ToolBlock.js'
import { UserTextBlock } from './UserTextBlock.js'
import type { RenderBlock } from './utils/normalizeParts.js'
import { normalizeParts } from './utils/normalizeParts.js'

const wrap = css`
  display: flex;
  flex-direction: column;
  padding: 4px 0;
`

const row = css`
  display: flex;
  gap: 8px;
  align-items: flex-start;
`

const content = css`
  flex: 1;
  min-width: 0;
  padding-top: 2px;
`

/** 连续 tool 组：flex column + gap，确保展开后块间有间距不重叠 */
const groupContent = css`
  display: flex;
  flex-direction: column;
  gap: 2px;
`

/** 连续 tool 组行：stretch 让 PartDecoration 竖线贯通全组高度 */
const toolGroupRow = css`
  align-items: stretch;
`

/** 可 shake 但未选中：淡琥珀色高亮，可点击 */
const shakeable = css`
  border-radius: 6px;
  cursor: pointer;
  background: color-mix(in srgb, var(--warning) 8%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warning) 40%, transparent);
  transition: background 0.12s ease;

  &:hover {
    background: color-mix(in srgb, var(--warning) 15%, transparent);
  }
`

/** 可 shake 且已选中：强琥珀色高亮 */
const shakeSelected = css`
  border-radius: 6px;
  cursor: pointer;
  background: color-mix(in srgb, var(--warning) 20%, transparent);
  box-shadow: inset 0 0 0 2px var(--warning);

  &:hover {
    background: color-mix(in srgb, var(--warning) 25%, transparent);
  }
`

const shakeBadge = css`
  position: absolute;
  top: -2px;
  right: 0;
  z-index: 1;
  font-size: 10px;
  font-family: ui-monospace, monospace;
  color: var(--warning);
  background: color-mix(in srgb, var(--bg) 80%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 50%, transparent);
  border-radius: 3px;
  padding: 0 4px;
  pointer-events: none;
  white-space: nowrap;
`

const shakeRow = css`
  position: relative;
`

/** shake 可点击块：重置 button 默认样式，仅保留可交互语义 */
const shakeButton = css`
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  border: 0;
  margin: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: inherit;
  width: 100%;
  cursor: pointer;
`

/**
 * 找到与渲染块匹配的 shake 区域。
 * - tool 块：按 toolCallId 匹配（跨消息合并后仍可靠）
 * - text/thinking 块：按 partIndex 匹配（messageId 已在调用前过滤）
 */
function matchShakeRegions(block: RenderBlock, msgRegions: ShakeRegionView[]): ShakeRegionView[] {
  if (block.type === 'tool') {
    return msgRegions.filter((r) => r.kind === 'toolResult' && r.toolCallId === block.id)
  }
  if (block.type === 'text' || block.type === 'thinking') {
    return msgRegions.filter((r) => r.kind === 'block' && r.partIndex === block.partIndex)
  }
  return []
}

type ToolRenderBlock = Extract<RenderBlock, { type: 'tool' }>

/**
 * 把连续的 tool 块合并为一组，用于共享装饰列的紧凑渲染。
 * 非 tool 块各自成组（单元素数组）。
 */
function groupConsecutiveTools(blocks: RenderBlock[]): RenderBlock[][] {
  const result: RenderBlock[][] = []
  let i = 0
  while (i < blocks.length) {
    const cur = blocks[i]
    if (!cur) break
    if (cur.type === 'tool') {
      const group: RenderBlock[] = [cur]
      i++
      while (i < blocks.length) {
        const next = blocks[i]
        if (next?.type !== 'tool') break
        group.push(next)
        i++
      }
      result.push(group)
    } else {
      result.push([cur])
      i++
    }
  }
  return result
}

export const MessageItem = memo(function MessageItem({
  message,
  latency,
}: {
  message: Message
  latency?: number
}) {
  const shake = useShakeMode()
  const blocks = normalizeParts(message)
  const msgRegions = shake?.enabled ? (shake.regionsByMessage.get(message.id) ?? []) : []

  // shake 模式需逐块高亮，不分组；正常模式合并连续 tool 以紧凑显示
  const groups = shake?.enabled ? blocks.map((b) => [b]) : groupConsecutiveTools(blocks)

  return (
    <div className={wrap} data-testid="message" data-role={message.role} data-msg-id={message.id}>
      {groups.map((group, gi) => {
        // 连续 tool 组：共享装饰列 + 紧凑堆叠
        if (group.length > 1 && group.every((b) => b.type === 'tool')) {
          // 上方 every 已保证全为 tool 块，filter 仅用于把联合类型收窄为 ToolRenderBlock
          const toolGroup = group.filter((b): b is ToolRenderBlock => b.type === 'tool')
          const [head] = toolGroup
          if (!head) return null
          return (
            <div className={`${row} ${toolGroupRow}`} key={`tg-${gi}`}>
              <PartDecoration block={head} />
              <div className={`${content} ${groupContent}`}>
                {toolGroup.map((b) => (
                  <ToolBlock key={b.id} block={b} compact />
                ))}
              </div>
            </div>
          )
        }

        const [block] = group
        if (!block) return null
        // shake 高亮：先计算，以便传递 forceExpand 给折叠块
        const blockRegions = msgRegions.length > 0 ? matchShakeRegions(block, msgRegions) : []
        const shakeActive = blockRegions.length > 0
        const forceExpand = shakeActive

        let body: ReactNode = null
        switch (block.type) {
          case 'text':
            body =
              block.role === 'user' ? (
                <UserTextBlock text={block.text} />
              ) : (
                <AssistantTextBlock
                  text={block.text}
                  completedAt={message.createdAt || undefined}
                  latency={latency}
                  forceExpand={forceExpand}
                />
              )
            break
          case 'thinking':
            body = <ReasoningBlock text={block.text} forceExpand={forceExpand} />
            break
          case 'steering':
            body = <UserTextBlock text={block.text} />
            break
          case 'tool':
            body = <ToolBlock block={block} forceExpand={forceExpand} />
            break
        }

        const allSelected =
          shakeActive && blockRegions.every((r) => shake?.selected.has(r.id) ?? false)
        const shakeCls = shakeActive ? `${shakeRow} ${allSelected ? shakeSelected : shakeable}` : ''
        const shakeTokens = blockRegions.reduce((sum, r) => sum + r.tokens, 0)

        const blockKey =
          'id' in block ? `${block.type}-${block.id}` : `${block.type}-${block.partIndex}`
        const toggleRegions = () => {
          for (const r of blockRegions) shake?.onToggle(r.id)
        }
        const inner = (
          <>
            <PartDecoration block={block} />
            <div className={content}>{body}</div>
            {shakeActive && <span className={shakeBadge}>{shakeTokens}t</span>}
          </>
        )

        return shakeActive ? (
          <button
            type="button"
            className={`${shakeButton} ${row} ${shakeCls}`}
            key={blockKey}
            onClick={(e) => {
              e.stopPropagation()
              toggleRegions()
            }}
            data-testid="shake-inline-block"
            data-shake-selected={allSelected}
          >
            {inner}
          </button>
        ) : (
          <div className={`${row} ${shakeCls}`} key={blockKey}>
            {inner}
          </div>
        )
      })}
    </div>
  )
})
