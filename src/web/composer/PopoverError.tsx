import { css } from '@linaria/core'

const wrap = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--haze-color-danger, #e5484d);
`

const retry = css`
  flex: none;
  margin-left: auto;
  padding: 2px 8px;
  font-size: 12px;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: none;
  color: inherit;
  cursor: pointer;
`

type Props = {
  /** 失败原因全文（由调用方取 message）。 */
  message: string
  onRetry?: () => void
}

/**
 * 浮层候选源读取失败时的提示行。
 *
 * 此前失败与「没有匹配」渲染完全一致（浮层消失或空列表），用户据此认定
 * 「这个文件/命令/工作流不存在」，紧接着按 Enter 把字面量 `@foo` 当正文发出去。
 */
function PopoverError(props: Props) {
  return (
    // 整行吞掉 mousedown 的默认行为：点「重试」不该把焦点从输入框挪走
    // （与各浮层候选列表同一处理）。
    <div className={wrap} role="alert" onMouseDown={(e) => e.preventDefault()}>
      <span>{props.message}</span>
      {props.onRetry ? (
        <button type="button" className={retry} onClick={props.onRetry}>
          重试
        </button>
      ) : null}
    </div>
  )
}

export { PopoverError }
