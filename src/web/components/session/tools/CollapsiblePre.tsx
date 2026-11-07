import { css } from '@linaria/core'
import type { ReactNode } from 'react'
import { useOverflow } from '@/components/session/hooks/useOverflow.js'

/** 文本输出的统一灰底 <pre>：折行显示、长词可断（终端输出/匹配行是散文，不是代码）。 */
const pre = css`
  margin: 0;
  padding: 8px;
  background: var(--haze-color-bg-muted);
  border-radius: 6px;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
`

/** 折叠档位：限高且裁剪。只限高不裁剪的话，超长输出会照样画到盒子之外：折叠态
 *  看起来没折叠，「展开」按钮被压在输出文字上，虚拟化行高（量的是这个盒子）
 *  也会小于实际绘制高度、让输出盖住下一条消息。 */
const collapsedWindow = css`
  overflow: hidden;
`

/** 展开档位：限高 + 纵向滚动——完整内容仍可达，又不占满时间线挤压后续块。 */
const expandedWindow = css`
  overflow: auto;
`

const btn = css`
  font-size: 12px;
  color: var(--haze-color-primary);
  background: transparent;
  border: none;
  cursor: pointer;
`

/**
 * 可折叠的输出块：内容高于折叠档位才出现「展开/收起」，折叠态裁剪、展开态限高滚动。
 * 档位可调（工具输出 200/400，文件代码块 300/600），检测与按钮只此一份实现。
 */
export function CollapsiblePre({
  children,
  collapsedHeight = 200,
  expandedHeight = 400,
  testId,
  preClassName,
}: {
  /** 输出内容：字符串渲染成统一灰底 <pre>；自定义内容（如 shiki 代码块）原样放入。 */
  children: ReactNode
  /** 折叠档位（px）：内容高于此值才出现「展开」。默认 200。 */
  collapsedHeight?: number
  /** 展开档位（px）：展开后的限高滚动窗口。默认 400。 */
  expandedHeight?: number
  /** 字符串内容渲染出的 <pre> 的 testid。 */
  testId?: string
  /** 追加到字符串内容 <pre> 的样式类（如 bash 输出与命令块的上间距）。 */
  preClassName?: string
}) {
  const { ref, overflowing, expanded, toggle } = useOverflow(collapsedHeight)
  return (
    <div>
      <div
        ref={ref}
        className={expanded ? expandedWindow : collapsedWindow}
        style={{ maxHeight: expanded ? expandedHeight : collapsedHeight }}
      >
        {typeof children === 'string' ? (
          <pre data-testid={testId} className={preClassName ? `${pre} ${preClassName}` : pre}>
            {children}
          </pre>
        ) : (
          children
        )}
      </div>
      {overflowing && (
        <button type="button" className={btn} onClick={toggle}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  )
}
