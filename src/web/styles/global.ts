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
`
