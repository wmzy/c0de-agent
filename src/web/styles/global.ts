import { css } from '@linaria/core'
import { themeVars } from './theme.js'

// linaria v5: 每个全局选择器单独用 :global(...)，不嵌套 :global() { block }。
export const globalStyle = css`
  ${themeVars}
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
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
  }
  :global(button) {
    cursor: pointer;
    font: inherit;
    min-height: 44px;
    min-width: 44px;
  }
  /*
   * 表单控件全局基础样式：所有页面未单独设置样式的 input/select/textarea
   * 都回退到这里，用 CSS 变量随明暗主题切换，避免暗色模式下出现白底黑字。
   */
  :global(input),
  :global(select),
  :global(textarea) {
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    min-height: 44px;
  }
  /* select 自定义箭头：原生箭头在暗色下不可见，统一用中性灰三角 */
  :global(select) {
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path fill='%238a8a8a' d='M6 8L2 4h8z'/></svg>");
    background-repeat: no-repeat;
    background-position: right 10px center;
    padding-right: 30px;
  }
  :global(textarea) {
    resize: vertical;
  }
  :global(input:focus),
  :global(select:focus),
  :global(textarea:focus) {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 25%, transparent);
  }
  :global(input::placeholder),
  :global(textarea::placeholder) {
    color: var(--text-secondary);
  }
  :global(input:disabled),
  :global(select:disabled),
  :global(textarea:disabled) {
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
    accent-color: var(--primary);
  }
  :global(input[type='range']) {
    min-height: 0;
    padding: 0;
    accent-color: var(--primary);
  }
  /* 统一按钮基础：组件内可用 className 覆盖，无样式时也有得体外观 */
  :global(button) {
    color: var(--text);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    transition: background 0.15s, border-color 0.15s;
  }
  :global(button:hover:not(:disabled)) {
    background: color-mix(in srgb, var(--bg-secondary) 80%, var(--text) 8%);
  }
  :global(button:disabled) {
    opacity: 0.5;
    cursor: not-allowed;
  }
  /* 按钮变体：组件用 data-variant 声明语义，跨文件统一外观 */
  :global(button[data-variant='primary']) {
    background: var(--primary);
    border-color: var(--primary);
    color: #fff;
  }
  :global(button[data-variant='primary']:hover:not(:disabled)) {
    background: var(--primary-hover);
    border-color: var(--primary-hover);
  }
  :global(button[data-variant='danger']) {
    color: var(--error);
    border-color: color-mix(in srgb, var(--error) 45%, var(--border));
  }
  :global(button[data-variant='danger']:hover:not(:disabled)) {
    background: color-mix(in srgb, var(--error) 12%, var(--bg-secondary));
  }
  :global(button[data-variant='ghost']) {
    background: transparent;
    border-color: transparent;
  }
  :global(button[data-variant='ghost']:hover:not(:disabled)) {
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }
`
