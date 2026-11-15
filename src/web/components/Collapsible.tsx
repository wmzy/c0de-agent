import type { ReactNode } from 'react'
import { useState } from 'react'

/**
 * 折叠头箭头字形：纯装饰，必须 aria-hidden——开/关状态由所在按钮的 aria-expanded
 * 播报，读屏把 ▸/▾ 念成「黑色小三角」只有噪声。收敛前 6 处折叠头只有 1 处标了
 * aria-hidden，本原语统一口径；折叠头特化过深、不迁 Collapsible 的站（ToolBlock/
 * TodoPanel）也复用这里的箭头或遵循同一 a11y 口径。
 */
export function CollapseArrow({ open, className }: { open: boolean; className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      {open ? '▾' : '▸'}
    </span>
  )
}

type CollapsibleProps = {
  /** 折叠头内容（标题/预览等，渲染在箭头之后），样式由调用方组合。 */
  header: ReactNode
  /** 展开区内容。 */
  children: ReactNode
  /** 受控展开态：调用方还需要 open 做别的事时用（CodeReference 以它控制 useQuery
   * 的 enabled、ReasoningBlock 以 forceExpand 覆盖显示）；缺省为非受控。 */
  open?: boolean
  /** 非受控初始展开态，默认收起。 */
  defaultOpen?: boolean
  /** 展开/收起回调；受控模式不提供则按钮不生效。 */
  onOpenChange?: (open: boolean) => void
  /** 内容常驻 DOM：折叠态挂 data-collapsed 隐藏而非卸载（textContent 仍可读，
   * LLMDetail 的「摘要 + 展开原始内容」语义）；默认收起即卸载。 */
  keepMounted?: boolean
  /** 折叠头按钮样式类（各站样式保持现状，由调用方传入）。 */
  headerClassName?: string
  /** 折叠头按钮 testid（各站既有断言依赖）。 */
  testId?: string
  /** 展开区样式类。 */
  bodyClassName?: string
  /** 展开区 testid。 */
  bodyTestId?: string
}

/**
 * 折叠区块原语：收敛「toggle 按钮 + ▸/▾ 箭头 + aria-expanded + 展开/收起」骨架。
 * 此前 LLMDetail/ReasoningBlock/SessionSummary/CodeReference/ToolBlock/TodoPanel
 * 各持一份手写副本，a11y 属性逐站漂移。只收敛骨架：外层容器与按钮内的其余内容
 * 由调用方自带，样式类全部由调用方传入，保持各站视觉现状。
 */
export function Collapsible({
  header,
  children,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  keepMounted = false,
  headerClassName,
  testId,
  bodyClassName,
  bodyTestId,
}: CollapsibleProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const open = openProp ?? internalOpen
  const toggle = () => {
    const next = !open
    if (openProp === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }
  return (
    <>
      <button
        type="button"
        className={headerClassName}
        onClick={toggle}
        aria-expanded={open}
        data-testid={testId}
      >
        <CollapseArrow open={open} />
        {header}
      </button>
      {keepMounted ? (
        <div className={bodyClassName} data-collapsed={!open || undefined} data-testid={bodyTestId}>
          {children}
        </div>
      ) : open ? (
        <div className={bodyClassName} data-testid={bodyTestId}>
          {children}
        </div>
      ) : null}
    </>
  )
}
