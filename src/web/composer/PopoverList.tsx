import { css } from '@linaria/core'
import { type ReactNode, useRef } from 'react'
import { PopoverError } from '@/composer/PopoverError.js'
import { usePopoverScroll } from '@/composer/usePopoverScroll.js'

const popover = css`
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  box-shadow: var(--haze-shadow-md);
  max-height: 240px;
  overflow: auto;
  z-index: 10;
`

/**
 * 候选项按钮基类：斜杠命令 / 子命令 / 工作流共用（名称行 + 描述/参数行纵向堆叠）。
 * 「active」类由键盘高亮驱动（与 aria-selected 同步），hover 供鼠标路径。
 */
export const popoverItem = css`
  display: flex;
  flex-direction: column;
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  cursor: pointer;
  background: none;
  border: none;
  color: var(--haze-color-text);
  &:hover,
  &.active {
    background: var(--haze-color-bg-subtle);
  }
`

/** 候选项按钮：单行块状变体（@ 文件路径 / agent 提及）。 */
export const popoverItemBlock = css`
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  cursor: pointer;
  background: none;
  border: none;
  color: var(--haze-color-text);
  font-size: 13px;
  &:hover,
  &.active {
    background: var(--haze-color-bg-subtle);
  }
`

/** 候选项按钮的单一封装（role=option + aria-selected + active 类 + 点击）。
 *  此前 6 处渲染点各手抄同一段 button 咒语，aria-selected 与 active 类的配对
 *  必须与 usePopoverScroll 的 activeIndex 契约逐份保持同步；activeIndex 的
 *  判定留在调用方（@ 弹层的 agent+文件两段偏移等口径各不相同）。 */
export function PopoverOption({
  active,
  onSelect,
  block,
  children,
}: {
  active: boolean
  onSelect: () => void
  /** 单行块状变体（默认为纵向堆叠变体）。 */
  block?: boolean
  children: ReactNode
}) {
  return (
    <button
      role="option"
      aria-selected={active}
      className={`${block ? popoverItemBlock : popoverItem} ${active ? 'active' : ''}`}
      onClick={onSelect}
      type="button"
    >
      {children}
    </button>
  )
}

/** 加载/空态提示行（非候选项，不参与键盘索引）。 */
const hint = css`
  padding: 8px 12px;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
`

type Props = {
  /** 候选项数量：0 时进入空态分支，>0 渲染 listbox。 */
  itemCount: number
  /** 当前键盘高亮项下标（透传 usePopoverScroll，滚进可视区）。 */
  activeIndex: number
  /** 候选源仍在加载中（结果未到）。 */
  loading?: boolean
  /** 读取失败的完整提示文案（含前缀，如 `命令列表加载失败：…`）；非空渲染失败行。 */
  error?: string | null
  /** 失败行的重试入口。 */
  onRetry?: () => void
  /** 加载中提示文案（如「命令加载中…」）。 */
  loadingHint: string
  /** 候选列表容器 testid；失败/加载态容器派生为 `<testId>-error` / `<testId>-loading`。 */
  testId: string
  /** 候选项（由调用方渲染，通常套 popoverItem / popoverItemBlock）。 */
  children: ReactNode
}

/**
 * composer 浮层骨架：容器样式 + 空态三段分支 + listbox 接线。
 *
 * 四个浮层（斜杠命令 / 子命令 / 工作流 / @ 文件）此前各自复制同一套骨架，仅候选
 * 渲染不同，收敛于此；调用方只负责画候选项。空态口径（各浮层此前逐份复制、且都
 * 修过同一批 bug，不得漂移）：
 *   1. 失败优先于「空/加载中」——读不到时浮层整个消失会让用户把字面量 `/cmd`、
 *      `@foo` 当正文发出去；
 *   2. 加载中渲染提示行——「还在搜」和「搜完了没有」必须可区分；
 *   3. 非 loading 的空结果不渲染——「确实没有匹配」时浮层理应消失。
 */
function PopoverList(props: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  // usePopoverScroll 必须无条件调用（hooks 数量跨渲染恒定）；itemCount 为 0 时
  // open=false，effect 直接短路。
  usePopoverScroll(listRef, props.activeIndex, props.itemCount > 0)
  if (props.itemCount === 0) {
    if (props.error) {
      return (
        <div className={popover} data-testid={`${props.testId}-error`}>
          <PopoverError message={props.error} onRetry={props.onRetry} />
        </div>
      )
    }
    if (!props.loading) return null
    return (
      <div className={popover} role="status" data-testid={`${props.testId}-loading`}>
        <div className={hint}>{props.loadingHint}</div>
      </div>
    )
  }
  return (
    <div
      ref={listRef}
      className={popover}
      role="listbox"
      data-testid={props.testId}
      // 吞掉 mousedown 的默认行为：点击候选不该把焦点从输入框挪走（键盘索引
      // 依赖输入框持有焦点，onMouseDown 在 focus 转移之前触发）。
      onMouseDown={(e) => e.preventDefault()}
    >
      {props.children}
    </div>
  )
}

export { PopoverList }
