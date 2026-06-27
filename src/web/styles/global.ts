import { css } from '@linaria/core'
import { themeVars } from './theme.js'

export const globalStyle = css`
  ${themeVars}
  :global() {
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    html,
    body,
    #root {
      height: 100%;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      -webkit-font-smoothing: antialiased;
    }
    button {
      cursor: pointer;
      font: inherit;
      min-height: 44px;
      min-width: 44px;
    }
  }
`
