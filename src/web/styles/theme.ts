import { css } from '@linaria/core'

// linaria v5: :global 作用于单个选择器，不能写成 :global() { block } 嵌套。
// 全局变量定义在 :root，暗色通过 .dark 类覆盖。
export const themeVars = css`
  :global(:root) {
    --bg: #ffffff;
    --bg-secondary: #f5f5f5;
    --text: #1a1a1a;
    --text-secondary: #666666;
    --border: #e0e0e0;
    --primary: #2563eb;
    --primary-hover: #1d4ed8;
    --success: #16a34a;
    --warning: #d97706;
    --error: #dc2626;
    --code-bg: #f6f8fa;
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    --diff-add-bg: #e6ffec;
    --diff-add-text: #1a7f37;
    --diff-del-bg: #ffebe9;
    --diff-del-text: #cf222e;
  }
  :global(.dark) {
    --bg: #0d1117;
    --bg-secondary: #161b22;
    --text: #e6edf3;
    --text-secondary: #8b949e;
    --border: #30363d;
    --primary: #58a6ff;
    --primary-hover: #79c0ff;
    --success: #3fb950;
    --warning: #d29922;
    --error: #f85149;
    --code-bg: #161b22;
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    --diff-add-bg: #0d2818;
    --diff-add-text: #3fb950;
    --diff-del-bg: #2d0a0a;
    --diff-del-text: #f85149;
  }
`
