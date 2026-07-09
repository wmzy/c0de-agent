import { css } from '@linaria/core'

/**
 * 多个 Settings 子面板共用的 Linaria 样式。
 *
 * 所有 `css\`...\`` 模板必须在模块顶层定义，否则 @wyw-in-js 无法静态提取。
 * 本文件只放「跨面板复用」的样式；仅单个面板使用的样式跟随其面板文件。
 */

/** 设置分区容器：标题 + 字段纵向堆叠，底部分隔线。 */
const section = css`
  padding: 16px;
  border-bottom: 1px solid var(--border);
`

/** 单行字段：标签 + 控件水平排列。 */
const field = css`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
`

/** 字段内输入控件：弹性宽度、上限 320px。 */
const fieldInput = css`
  flex: 1;
  max-width: 320px;
`

/** 说明文本：小号、次级色、上间距。 */
const hint = css`
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
`

/** 复选框行：可点击整行切换。 */
const checkRow = css`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  cursor: pointer;
`

/** key-value 行：多输入框紧凑排列（角色路由等）。 */
const kvRow = css`
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
`

/** 灰化提示文本（独立出现时）。 */
const mutedHint = css`
  color: var(--text-secondary);
  font-size: 13px;
`

/** hint 文本带下边距的变体。 */
const hintMb = css`
  margin-bottom: 8px;
`

export { checkRow, field, fieldInput, hint, hintMb, kvRow, mutedHint, section }
