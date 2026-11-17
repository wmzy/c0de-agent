import { css } from '@linaria/core'
import { memo, useState } from 'react'
import { Collapsible } from '@/components/Collapsible.js'
import { Markdown } from '@/components/Markdown.js'
import { ellipsisCss } from '@/styles/shared.js'

const wrap = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  overflow: hidden;
`

const header = css`
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  text-align: left;
  cursor: pointer;
  background: var(--haze-color-bg-subtle);
  font-size: 13px;
  color: var(--haze-color-text-secondary);
`

const title = css`
  flex-shrink: 0;
`

const preview = css`
  ${ellipsisCss}
  flex: 1;
  color: var(--haze-color-text-secondary);
  opacity: 0.7;
`

const body = css`
  padding: 8px 12px;
  font-size: 13px;
  max-height: 400px;
  overflow-y: auto;
`

/** 取思考文本的最后一个非空行，作为折叠态预览。 */
function lastNonEmptyLine(text: string): string {
  const line = text.trimEnd().split('\n').pop() ?? ''
  return line.trim()
}

export const ReasoningBlock = memo(function ReasoningBlock({
  text,
  forceExpand,
}: {
  text: string
  forceExpand?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const isExpanded = forceExpand || expanded
  const previewLine = isExpanded ? '' : lastNonEmptyLine(text)
  return (
    <div className={wrap} data-testid="reasoning" data-expanded={isExpanded}>
      {/* 展开骨架收敛在 Collapsible（受控：forceExpand 时点击不改显示态）；
          头部额外带末行预览，作为 header 传入。 */}
      <Collapsible
        open={isExpanded}
        onOpenChange={setExpanded}
        headerClassName={header}
        testId="reasoning-toggle"
        bodyClassName={body}
        header={
          <>
            <span className={title}>思考过程</span>
            {previewLine && (
              <span className={preview} data-testid="reasoning-preview">
                {previewLine}
              </span>
            )}
          </>
        }
      >
        <Markdown content={text} />
      </Collapsible>
    </div>
  )
})
