import { css } from '@linaria/core'
import type { Message } from '@shared/types/message.js'
import type { ReactNode } from 'react'
import { AssistantTextBlock } from './AssistantTextBlock.js'
import { PartDecoration } from './PartDecoration.js'
import { ReasoningBlock } from './ReasoningBlock.js'
import { useShakeMode } from './ShakeContext.js'
import { ToolBlock } from './ToolBlock.js'
import { UserTextBlock } from './UserTextBlock.js'
import type { RenderBlock } from './utils/normalizeParts.js'
import { normalizeParts } from './utils/normalizeParts.js'
import type { ShakeRegionView } from '../../types/index.js'

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

export function MessageItem({ message, latency }: { message: Message; latency?: number }) {
  const shake = useShakeMode()
  const blocks = normalizeParts(message)
  const msgRegions =
    shake?.enabled ? (shake.regionsByMessage.get(message.id) ?? []) : []

  return (
    <div className={wrap} data-testid="message" data-role={message.role} data-msg-id={message.id}>
      {blocks.map((block, i) => {
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
          shakeActive && blockRegions.every((r) => shake!.selected.has(r.id))
        const shakeCls = shakeActive
          ? `${shakeRow} ${allSelected ? shakeSelected : shakeable}`
          : ''
        const shakeTokens = blockRegions.reduce((sum, r) => sum + r.tokens, 0)

        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 消息 part 无稳定 id，按索引作 key
          <div
            className={`${row} ${shakeCls}`}
            key={`${block.type}-${i}`}
            onClick={
              shakeActive
                ? (e) => {
                    e.stopPropagation()
                    for (const r of blockRegions) shake!.onToggle(r.id)
                  }
                : undefined
            }
            data-testid={shakeActive ? 'shake-inline-block' : undefined}
            data-shake-selected={shakeActive ? allSelected : undefined}
          >
            <PartDecoration block={block} />
            <div className={content}>{body}</div>
            {shakeActive && <span className={shakeBadge}>{shakeTokens}t</span>}
          </div>
        )
      })}
    </div>
  )
}
