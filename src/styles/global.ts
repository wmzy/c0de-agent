import { css } from '@linaria/core'

export const globalStyles = css`
  :global() {
    :root {
      --haze-color-primary: #0066ff;
      --haze-color-primary-hover: #0052cc;
      --haze-color-primary-active: #003d99;
      --haze-color-primary-subtle: #e6f0ff;
      --haze-color-bg: #ffffff;
      --haze-color-bg-subtle: #f0f2f5;
      --haze-color-bg-muted: #eef0f4;
      --haze-color-text: #1a1a1a;
      --haze-color-text-secondary: #4a4a4a;
      --haze-color-text-muted: #6b6b6b;
      --haze-color-text-inverse: #ffffff;
      --haze-color-border: #c8c8c8;
      --haze-color-border-hover: #b0b0b0;
      --haze-color-success: #16a34a;
      --haze-color-warning: #f59e0b;
      --haze-color-danger: #dc2626;
      --haze-color-info: #2563eb;
      --haze-color-focus-ring: rgba(0, 102, 255, 0.4);
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      padding: 0;
      font-family: var(--haze-font-sans);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      line-height: var(--haze-leading-normal);
    }

    body {
      background-color: var(--haze-color-bg);
      color: var(--haze-color-text);
    }

    #root {
      min-height: 100vh;
    }

    a {
      color: var(--haze-color-text);
      text-decoration: none;
      transition: color 0.15s ease;
    }

    button {
      cursor: pointer;
    }

    ::selection {
      background-color: var(--haze-color-primary-subtle);
      color: var(--haze-color-primary);
    }

    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }

    ::-webkit-scrollbar-track {
      background: transparent;
    }

    ::-webkit-scrollbar-thumb {
      background: var(--haze-color-border);
      border-radius: 3px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: var(--haze-color-border-hover);
    }
  }
`
