// 跨组件共享的 CSS 声明片段（非 linaria 类）：单行省略号截断五件套。
// 此前 ~20 个组件逐字复制这套声明且已现漂移（有的漏 min-width、有的属性序
// 不一），收敛为单一出处，组件本地模板内插使用：css`${ellipsisCss} flex: 1;`。
//
// 为什么是 CSS 文本片段而不是 css`` 类：本仓 @wyw-in-js 工具链不支持在
// css`` 模板里内插类名做组合——类名会被原样吐进声明块，产出非法 CSS
// （实测 `.x{abc123 flex:1;}`，flex 声明随之被浏览器丢弃）；片段内插则逐字
// 展开，输出与此前各组件手抄完全一致。
//
// min-width: 0：flex/grid 子项默认 min-width:auto 不收缩，置 0 省略号才
// 生效；overflow 非 visible 时自动最小尺寸本就为 0，因此对已带
// overflow: hidden 的元素统一带上 min-width: 0 无视觉差。
export const ellipsisCss = `
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

/** 禁用态视觉：降不透明度 + not-allowed 光标。此前 6+ 处组件在各自的
 *  css`` 模板里逐字复制这两行（Dialog 关闭键 / TodoPanel 添加键 /
 *  ToolToggle 触发键 / 确认弹窗按钮家族等），收敛为单一出处，组件本地
 *  模板内插使用：css`${disabledCss}` 或嵌在更大模板里。
 * 同样必须是 CSS 文本片段而非类（理由见上）。注意与 global.ts
 * :where(button):disabled 的全局禁用语义（文字降对比、背景变浅）是叠加
 * 关系而非替代：本片段是组件类对「视觉弱化 + 光标」的补充声明。 */
export const disabledCss = `
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`
