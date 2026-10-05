import { css } from '@linaria/core'
import { MOBILE } from '@/styles/breakpoints.js'

/**
 * 多个 Settings 子面板共用的 Linaria 样式。
 *
 * 所有 `css\`...\`` 模板必须在模块顶层定义，否则 @wyw-in-js 无法静态提取。
 * 本文件只放「跨面板复用」的样式；仅单个面板使用的样式跟随其面板文件。
 */

/** 设置分区容器：标题 + 字段纵向堆叠，底部分隔线。 */
const section = css`
  padding: 16px;
  border-bottom: 1px solid var(--haze-color-border);
`

/** 分区标题（h2 语义）：紧凑尺寸，避免浏览器 h2 默认字号放大分区头。 */
const sectionTitle = css`
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 10px;
`

/**
 * 单行字段：标签 + 控件水平排列；窄屏折行为「标签一行、控件一行」。
 *
 * 标签禁止收缩（flex 子项默认 shrink:1）只解决了「标签被控件压成竖排断行」，
 * 反过来让长标签变成不可压缩的宽度地板：用量面板的「月度 token 预算
 * （input+output+cacheRead，0 = 不限制；兜底价格未知的调用）」实测单行占
 * 585px，390px 视口下把 <input> 顶到 left=609（视口外 219px），输入框只剩
 * 26px 露在右缘，且 .haze-Workbench__editor 被撑出 245px 横向滚动——
 * 用户必须横向拖动才能填预算。
 *
 * 窄屏改用 flex-wrap 让长标签整行折行（不压缩文字、不断词），控件自动落到
 * 第二行并铺满可用宽度；短标签（如「主题」）在 390px 下仍与控件同行，
 * 桌面端布局完全不变。
 */
const field = css`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;

  /* 标签文字不随控件宽度压缩（flex 子项默认 shrink:1，长 select 会把
   * 「主题」这类标签挤成竖排断行）；min-width:0 + 折行让超长标签能换行，
   * 不再成为把控件顶出视口的宽度地板。 */
  & > span:first-child {
    flex-shrink: 0;
    min-width: 0;
  }

  ${MOBILE} {
    flex-wrap: wrap;

    & > span:first-child {
      flex-basis: 100%;
      white-space: normal;
      overflow-wrap: anywhere;
    }
  }
`

/** 字段内输入控件：弹性宽度、上限 320px（窄屏折行后铺满整行）。 */
const fieldInput = css`
  flex: 1;
  max-width: 320px;
  min-width: 0;
`

/** 说明文本：小号、次级色、上间距。 */
const hint = css`
  font-size: 12px;
  color: var(--haze-color-text-secondary);
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
  color: var(--haze-color-text-secondary);
  font-size: 13px;
`

/** hint 文本带下边距的变体。 */
const hintMb = css`
  margin-bottom: 8px;
`

export { checkRow, field, fieldInput, hint, hintMb, kvRow, mutedHint, section, sectionTitle }
