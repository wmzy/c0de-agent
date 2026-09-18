import { css } from '@linaria/core'

// linaria v5: 每个全局选择器单独用 :global(...)，不嵌套 :global() { block }。
// 设计令牌来自 haze-ui（--haze-color-* 等），由 main.tsx 挂载 spacing/typography/motion
// 静态类、ThemeContext 切换 haze-colors__lightTheme/darkTheme 颜色类。
//
// 原生控件基础样式只作用于非 haze 控件（:not([class*='haze-'])）：haze 的
// Input/Select/Textarea/Button 自带完整样式与焦点环，全局规则不再叠加。
// 保留原生外观的领域控件（ModelSelector/DirectoryPicker 自由输入、配对码、
// JsonConfigEditor 等）继续吃这套基础样式。
const NATIVE = ':not([class*="haze-"])'

export const globalStyle = css`
  :global(*) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }
  :global(html),
  :global(body),
  :global(#root) {
    height: 100%;
  }
  :global(body) {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--haze-color-bg);
    color: var(--haze-color-text);
    -webkit-font-smoothing: antialiased;
  }
  :global(button) {
    cursor: pointer;
    font: inherit;
  }
  /*
   * 表单控件全局基础样式：原生 input/select/textarea 回退到这里，
   * 用 CSS 变量随明暗主题切换，避免暗色模式下出现白底黑字。
   */
  :global(input${NATIVE}),
  :global(select${NATIVE}),
  :global(textarea${NATIVE}) {
    font: inherit;
    color: var(--haze-color-text);
    background: var(--haze-color-bg);
    border: 1px solid var(--haze-color-border);
    border-radius: 6px;
    padding: 8px 10px;
    min-height: 44px;
  }
  /* select 自定义箭头：原生箭头在暗色下不可见，统一用中性灰三角 */
  :global(select${NATIVE}) {
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path fill='%238a8a8a' d='M6 8L2 4h8z'/></svg>");
    background-repeat: no-repeat;
    background-position: right 10px center;
    padding-right: 30px;
  }
  :global(textarea${NATIVE}) {
    resize: vertical;
  }
  :global(input${NATIVE}:focus),
  :global(select${NATIVE}:focus),
  :global(textarea${NATIVE}:focus) {
    outline: none;
    border-color: var(--haze-color-primary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--haze-color-primary) 25%, transparent);
  }
  :global(input${NATIVE}::placeholder),
  :global(textarea${NATIVE}::placeholder) {
    color: var(--haze-color-text-secondary);
  }
  /* 细滚动条：暗色下系统默认粗滚动条刺眼且挤压内容宽度；thumb 用中性灰随主题切换 */
  :global(*) {
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--haze-color-text-secondary) 45%, transparent) transparent;
  }
  :global(::-webkit-scrollbar) {
    width: 8px;
    height: 8px;
  }
  :global(::-webkit-scrollbar-thumb) {
    background: color-mix(in srgb, var(--haze-color-text-secondary) 45%, transparent);
    border-radius: 4px;
  }
  :global(::-webkit-scrollbar-thumb:hover) {
    background: color-mix(in srgb, var(--haze-color-text-secondary) 70%, transparent);
  }
  :global(::-webkit-scrollbar-track) {
    background: transparent;
  }
  :global(::-webkit-scrollbar-corner) {
    background: transparent;
  }
  :global(input${NATIVE}:disabled),
  :global(select${NATIVE}:disabled),
  :global(textarea${NATIVE}:disabled) {
    opacity: 0.6;
    cursor: not-allowed;
  }
  /* 复选框/单选/范围条不套用统一尺寸，保留原生外观 */
  :global(input[type='checkbox']),
  :global(input[type='radio']) {
    min-height: 0;
    padding: 0;
    width: 18px;
    height: 18px;
    accent-color: var(--haze-color-primary);
  }
  :global(input[type='range']) {
    min-height: 0;
    padding: 0;
    accent-color: var(--haze-color-primary);
  }
  /* 统一按钮基础：仅原生按钮（组件类按钮自持样式或走 haze Button） */
  :global(button${NATIVE}) {
    color: var(--haze-color-text);
    background: var(--haze-color-bg-subtle);
    border: 1px solid var(--haze-color-border);
    border-radius: 6px;
    padding: 8px 12px;
    transition: background 0.15s, border-color 0.15s;
  }
  :global(button${NATIVE}:hover:not(:disabled):not([aria-disabled='true'])) {
    background: color-mix(in srgb, var(--haze-color-bg-subtle) 80%, var(--haze-color-text) 8%);
  }
  /* 键盘可达性：Tab 聚焦时与输入控件同款焦点环（鼠标点击不触发） */
  :global(button${NATIVE}:focus-visible) {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--haze-color-primary) 25%, transparent);
    border-color: var(--haze-color-primary);
  }
  /*
   * 禁用态全局语义：真实 disabled 与 aria-disabled 等同——文字降对比度、
   * 背景变浅、cursor:not-allowed，hover 已被上方 :not() 守卫排除。
   */
  :global(button${NATIVE}:disabled),
  :global(button${NATIVE}[aria-disabled='true']) {
    color: var(--haze-color-text-muted);
    background: var(--haze-color-bg-muted);
    cursor: not-allowed;
  }
`
