import { css } from '@linaria/core'

/**
 * 跨组件复用的设计令牌原子类。
 *
 * 所有 `css\`...\`` 模板必须在模块顶层定义，否则 @wyw-in-js 无法静态提取。
 * 通过 className 组合使用：className={`${inputStyle} ${customClass}`}，
 * 组件内自定义类只声明增量样式（被本文件覆盖的属性须在自定义类中重申，
 * 因本文件作为依赖先于引用方求值，自定义类在后，按 CSS 源序覆盖）。
 */

/** 输入控件原子类：边框 / 4px 圆角 / 背景 / 文字色。 */
export const inputStyle = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
`

/** 卡片容器原子类：边框 / 6px 圆角 / 背景。 */
export const cardStyle = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
`

/** 小号按钮原子类：自适应尺寸 / 内边距 / 字号 / 边框 / 圆角 / 背景 / 文字色 / 指针 / 禁用态。 */
export const btnSm = css`
  min-height: auto;
  min-width: auto;
  padding: 4px 10px;
  font-size: 13px;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  cursor: pointer;
  &:disabled,
  &[aria-disabled='true'] {
    color: var(--haze-color-text-muted);
    background: var(--haze-color-bg-muted);
    cursor: not-allowed;
  }
`

/** 危险操作按钮（配合 haze Button outline 变体：危险文字与边框、悬停淡红底）。 */
export const btnDanger = css`
  color: var(--haze-color-danger);
  border-color: color-mix(in srgb, var(--haze-color-danger) 45%, var(--haze-color-border));
  &:hover:not(:disabled):not([aria-disabled='true']) {
    background: color-mix(in srgb, var(--haze-color-danger) 12%, var(--haze-color-bg-subtle));
  }
`
