import { css } from "@linaria/core";

export const globalStyles = css`
  :global() {
    /* ------------------------------------------------------------------
     * Design tokens — structural (fonts, sizes, spacing, shadows).
     * Colors live on .haze-colors__darkTheme (applied by App).
     * ------------------------------------------------------------------ */
    :root {
      /* Typography */
      --haze-font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
        Helvetica, Arial, 'PingFang SC', 'Hiragino Sans GB',
        'Microsoft YaHei', sans-serif;
      --haze-font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo,
        Consolas, 'Liberation Mono', monospace;

      /* Radius */
      --haze-radius-sm: 4px;
      --haze-radius-md: 8px;
      --haze-radius-lg: 12px;
      --haze-radius-full: 9999px;

      /* Spacing */
      --haze-space-1: 4px;
      --haze-space-2: 8px;
      --haze-space-3: 12px;
      --haze-space-4: 16px;
      --haze-space-5: 20px;
      --haze-space-6: 24px;
      --haze-space-7: 32px;
      --haze-space-8: 40px;

      /* Type scale */
      --haze-text-xs: 12px;
      --haze-text-sm: 13px;
      --haze-text-base: 14px;
      --haze-text-lg: 16px;
      --haze-text-xl: 20px;
      --haze-text-2xl: 24px;

      /* Leading & weight */
      --haze-leading-tight: 1.25;
      --haze-leading-normal: 1.5;
      --haze-leading-relaxed: 1.65;
      --haze-weight-medium: 500;
      --haze-weight-semibold: 600;
      --haze-weight-bold: 700;

      /* Shadows (tuned for dark surfaces) */
      --haze-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
      --haze-shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
      --haze-shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);

      /* Animation timing */
      --c0de-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
      --c0de-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    /* ------------------------------------------------------------------
     * Keyframe animations
     * ------------------------------------------------------------------ */
    @keyframes c0de-fadeInUp {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @keyframes c0de-fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes c0de-gradientShift {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    @keyframes c0de-pulse {
      0%, 100% { opacity: 0.95; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.03); }
    }

    @keyframes c0de-subtleBreathe {
      0%, 100% { filter: drop-shadow(0 4px 12px rgba(88, 166, 255, 0.25)); }
      50% { filter: drop-shadow(0 6px 20px rgba(88, 166, 255, 0.35)); }
    }

    /* ------------------------------------------------------------------
     * Dark palette — GitHub-inspired, applied via haze-ui darkTheme.
     * ------------------------------------------------------------------ */
    .haze-colors__darkTheme {
      --haze-color-primary: #58a6ff;
      --haze-color-primary-hover: #79b8ff;
      --haze-color-primary-active: #388bfd;
      --haze-color-primary-subtle: rgba(56, 139, 253, 0.15);
      --haze-color-bg: #0d1117;
      --haze-color-bg-subtle: #161b22;
      --haze-color-bg-muted: #21262d;
      --haze-color-muted: #21262d;
      --haze-color-text: #e6edf3;
      --haze-color-text-secondary: #c9d1d9;
      --haze-color-text-muted: #8b949e;
      --haze-color-text-inverse: #0d1117;
      --haze-color-border: #30363d;
      --haze-color-border-hover: #484f58;
      --haze-color-success: #3fb950;
      --haze-color-warning: #d29922;
      --haze-color-danger: #f85149;
      --haze-color-info: #58a6ff;
      --haze-color-focus-ring: rgba(88, 166, 255, 0.4);
    }

    /* ------------------------------------------------------------------
     * Resets
     * ------------------------------------------------------------------ */
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    html,
    body,
    #root {
      margin: 0;
      padding: 0;
    }

    html,
    body {
      font-family: var(--haze-font-sans);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      line-height: var(--haze-leading-normal);
    }

    body {
      background-color: var(--haze-color-bg);
      background-image:
        radial-gradient(ellipse 80% 50% at 50% -20%, rgba(88, 166, 255, 0.06) 0%, transparent 60%),
        radial-gradient(ellipse 60% 40% at 80% 100%, rgba(130, 80, 228, 0.03) 0%, transparent 50%);
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
      font-family: inherit;
    }

    /* ------------------------------------------------------------------
     * Selection / scrollbar
     * ------------------------------------------------------------------ */
    ::selection {
      background-color: rgba(88, 166, 255, 0.35);
      color: #fff;
    }

    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }

    ::-webkit-scrollbar-track {
      background: transparent;
    }

    ::-webkit-scrollbar-thumb {
      background: rgba(139, 148, 158, 0.25);
      border-radius: 3px;
      transition: background 0.2s;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: rgba(139, 148, 158, 0.45);
    }

    /* Firefox scrollbar */
    * {
      scrollbar-width: thin;
      scrollbar-color: rgba(139, 148, 158, 0.25) transparent;
    }

    /* ------------------------------------------------------------------
     * ChatMessage — role-based bubble polish on top of haze-ui defaults.
     * ------------------------------------------------------------------ */
    .haze-ChatMessage__wrapper {
      gap: 12px;
      padding: 4px 0;
      animation: c0de-fadeInUp 0.35s var(--c0de-ease-out) both;
    }

    .haze-ChatMessage__body {
      min-width: 0;
    }

    .haze-ChatMessage__bubble {
      font-size: var(--haze-text-base);
      line-height: var(--haze-leading-relaxed);
      padding: 12px 16px;
      border-radius: 12px;
      box-shadow: var(--haze-shadow-sm);
      transition: box-shadow 0.2s ease, transform 0.2s ease;
    }

    .haze-ChatMessage__bubble:hover {
      box-shadow: var(--haze-shadow-md);
    }

    .haze-ChatMessage__bubbleUser {
      background: linear-gradient(135deg, #1a5fb4 0%, #388bfd 50%, #58a6ff 100%);
      color: #fff;
      border: none;
      border-radius: 12px 12px 4px 12px;
      box-shadow:
        0 4px 14px rgba(31, 111, 235, 0.28),
        0 1px 3px rgba(0, 0, 0, 0.12),
        inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }

    .haze-ChatMessage__bubbleUser:hover {
      box-shadow:
        0 6px 20px rgba(31, 111, 235, 0.35),
        0 2px 6px rgba(0, 0, 0, 0.15),
        inset 0 1px 0 rgba(255, 255, 255, 0.12);
    }

    .haze-ChatMessage__bubbleAssistant {
      background: var(--haze-color-bg-subtle);
      border: 1px solid var(--haze-color-border);
      border-radius: 12px 12px 12px 4px;
      box-shadow:
        0 2px 8px rgba(0, 0, 0, 0.15),
        inset 0 1px 0 rgba(255, 255, 255, 0.03);
    }

    .haze-ChatMessage__bubbleAssistant:hover {
      border-color: var(--haze-color-border-hover);
    }

    .haze-ChatMessage__bubbleSystem {
      background: rgba(88, 166, 255, 0.06);
      color: var(--haze-color-text-muted);
      border: 1px solid rgba(88, 166, 255, 0.15);
      text-align: center;
      font-size: var(--haze-text-xs);
      max-width: 480px;
      margin-left: auto;
      margin-right: auto;
      border-radius: 8px;
    }

    .haze-ChatMessage__header {
      font-size: var(--haze-text-xs);
      color: var(--haze-color-text-muted);
      gap: 8px;
    }

    .haze-ChatMessage__headerUser {
      color: var(--haze-color-text-muted);
    }

    .haze-ChatMessage__statusText {
      font-size: var(--haze-text-xs);
      color: var(--haze-color-text-muted);
    }

    .haze-ChatMessage__statusError {
      color: var(--haze-color-danger);
    }

    .haze-ChatMessage__avatarSlot {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #58a6ff, #1f6feb);
      color: #fff;
      font-weight: 600;
      font-size: 13px;
      letter-spacing: 0.02em;
      box-shadow: 0 2px 8px rgba(88, 166, 255, 0.25);
      transition: transform 0.2s var(--c0de-ease-spring);
    }

    .haze-ChatMessage__avatarSlot:hover {
      transform: scale(1.08);
    }

    .haze-ChatMessage__wrapperUser .haze-ChatMessage__avatarSlot {
      background: linear-gradient(135deg, #f78166, #db61a2);
      box-shadow: 0 2px 8px rgba(247, 129, 102, 0.25);
    }

    /* ------------------------------------------------------------------
     * CodeBlock — haze-ui internal container refinements
     * ------------------------------------------------------------------ */
    .haze-CodeBlock__block {
      background: var(--haze-color-bg-subtle);
      border: 1px solid var(--haze-color-border);
      border-radius: 8px;
      font-family: var(--haze-font-mono);
      font-size: var(--haze-text-sm);
      line-height: var(--haze-leading-relaxed);
      overflow: hidden;
    }

    .haze-CodeBlock__pre {
      padding: 0;
      margin: 0;
    }

    .haze-CodeBlock__lang {
      top: 10px;
      right: 12px;
      font-size: var(--haze-text-xs);
      color: var(--haze-color-text-muted);
      font-family: var(--haze-font-mono);
      text-transform: lowercase;
      letter-spacing: 0.02em;
      background: var(--haze-color-bg-muted);
      padding: 2px 6px;
      border-radius: 4px;
    }

    /* ------------------------------------------------------------------
     * Token palette — for SyntaxHighlighter spans
     * ------------------------------------------------------------------ */
    .c0de-tok {
      display: inline;
      font-family: var(--haze-font-mono);
      color: var(--haze-color-text);
    }

    .c0de-tok-keyword {
      color: #ff7b72;
      font-weight: 600;
    }

    .c0de-tok-string {
      color: #a5d6ff;
    }

    .c0de-tok-comment {
      color: #6e7681;
      font-style: italic;
    }

    .c0de-tok-number {
      color: #79c0ff;
    }

    .c0de-tok-function {
      color: #d2a8ff;
    }

    .c0de-tok-builtin {
      color: #ffa657;
    }

    .c0de-tok-property {
      color: #79c0ff;
    }

    .c0de-tok-operator {
      color: #ff7b72;
    }

    .c0de-tok-punct {
      color: #6e7681;
    }

    .c0de-tok-tag {
      color: #7ee787;
    }

    .c0de-tok-attr {
      color: #79c0ff;
    }

    .c0de-tok-boolean {
      color: #79c0ff;
    }

    .c0de-tok-null {
      color: #79c0ff;
    }

    /* ------------------------------------------------------------------
     * Custom code-block wrapper — header with lang + copy, line numbers
     * ------------------------------------------------------------------ */
    .c0de-cb__wrapper {
      position: relative;
      margin: 10px 0;
      border: 1px solid var(--haze-color-border);
      border-radius: 10px;
      overflow: hidden;
      background: var(--haze-color-bg-subtle);
      box-shadow:
        var(--haze-shadow-sm),
        0 0 0 1px rgba(255, 255, 255, 0.02) inset;
      transition: border-color 0.2s ease;
    }

    .c0de-cb__wrapper:hover {
      border-color: var(--haze-color-border-hover);
    }

    .c0de-cb__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px 6px 12px;
      background: linear-gradient(180deg, var(--haze-color-bg-muted) 0%, rgba(33, 38, 45, 0.8) 100%);
      border-bottom: 1px solid var(--haze-color-border);
      font-size: var(--haze-text-xs);
    }

    .c0de-cb__lang {
      color: var(--haze-color-text-muted);
      font-family: var(--haze-font-mono);
      text-transform: lowercase;
      letter-spacing: 0.02em;
      user-select: none;
    }

    .c0de-cb__copy {
      background: transparent;
      border: 1px solid var(--haze-color-border);
      color: var(--haze-color-text-muted);
      padding: 3px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: var(--haze-text-xs);
      transition: all 0.2s var(--c0de-ease-out);
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .c0de-cb__copy:hover {
      background: rgba(88, 166, 255, 0.12);
      border-color: rgba(88, 166, 255, 0.4);
      color: var(--haze-color-primary);
      transform: translateY(-1px);
    }

    .c0de-cb__copy:active {
      transform: translateY(0);
    }

    .c0de-cb__copy[data-copied='true'] {
      background: rgba(63, 185, 80, 0.15);
      color: var(--haze-color-success);
      border-color: rgba(63, 185, 80, 0.4);
    }

    .c0de-cb__actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .c0de-cb__ref {
      background: transparent;
      border: 1px solid var(--haze-color-border);
      color: var(--haze-color-text-muted);
      padding: 3px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: var(--haze-text-xs);
      transition: all 0.2s var(--c0de-ease-out);
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .c0de-cb__ref:hover {
      background: rgba(188, 140, 255, 0.12);
      border-color: rgba(188, 140, 255, 0.4);
      color: #bc8cff;
      transform: translateY(-1px);
    }

    .c0de-cb__ref:active {
      transform: translateY(0);
    }

    .c0de-cb__ref[data-copied='true'] {
      background: rgba(63, 185, 80, 0.15);
      color: var(--haze-color-success);
      border-color: rgba(63, 185, 80, 0.4);
    }

    .c0de-ref {
      color: #bc8cff;
      font-family: var(--haze-font-mono);
      font-size: 0.9em;
      background: rgba(188, 140, 255, 0.1);
      border: 1px solid rgba(188, 140, 255, 0.25);
      border-radius: 4px;
      padding: 1px 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
    }

    .c0de-ref:hover {
      background: rgba(188, 140, 255, 0.2);
      border-color: rgba(188, 140, 255, 0.5);
    }

    .c0de-cb__body {
      display: flex;
      overflow-x: auto;
    }

    .c0de-cb__lines {
      padding: 12px 0;
      user-select: none;
      text-align: right;
      color: var(--haze-color-text-muted);
      font-family: var(--haze-font-mono);
      font-size: var(--haze-text-xs);
      line-height: var(--haze-leading-relaxed);
      min-width: 48px;
      background: rgba(13, 17, 23, 0.6);
      border-right: 1px solid var(--haze-color-border);
    }

    .c0de-cb__lineNo {
      display: block;
      padding: 0 10px;
      font-variant-numeric: tabular-nums;
    }

    .c0de-cb__code {
      padding: 12px 14px;
      flex: 1;
      color: var(--haze-color-text);
      font-family: var(--haze-font-mono);
      font-size: var(--haze-text-sm);
      line-height: var(--haze-leading-relaxed);
      white-space: pre;
      overflow-x: auto;
      margin: 0;
      tab-size: 2;
    }

    /* ------------------------------------------------------------------
     * Empty-state hero
     * ------------------------------------------------------------------ */
    .c0de-hero {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 20px;
      padding: 48px 24px;
      text-align: center;
      animation: c0de-fadeIn 0.6s var(--c0de-ease-out) both;
    }

    .c0de-hero__icon {
      width: 80px;
      height: 80px;
      color: var(--haze-color-primary);
      opacity: 0.95;
      animation: c0de-subtleBreathe 4s ease-in-out infinite;
    }

    .c0de-hero__title {
      font-size: 30px;
      font-weight: 700;
      margin: 0;
      background: linear-gradient(135deg, #58a6ff 0%, #d2a8ff 40%, #f78166 80%, #58a6ff 100%);
      background-size: 200% 200%;
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      letter-spacing: -0.025em;
      animation: c0de-gradientShift 6s ease-in-out infinite;
    }

    .c0de-hero__hint {
      font-size: var(--haze-text-lg);
      color: var(--haze-color-text-muted);
      max-width: 440px;
      line-height: 1.7;
      margin: 0;
    }

    .c0de-hero__chips {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      justify-content: center;
      max-width: 520px;
      margin-top: 8px;
      animation: c0de-fadeInUp 0.5s var(--c0de-ease-out) 0.2s both;
    }

    .c0de-hero__chip {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 10px 16px;
      background: var(--haze-color-bg-subtle);
      border: 1px solid var(--haze-color-border);
      border-radius: 9999px;
      color: var(--haze-color-text-secondary);
      font-size: var(--haze-text-sm);
      cursor: pointer;
      transition: all 0.25s var(--c0de-ease-out);
      font-family: var(--haze-font-sans);
    }

    .c0de-hero__chip:hover {
      background: rgba(88, 166, 255, 0.1);
      border-color: rgba(88, 166, 255, 0.4);
      color: #fff;
      transform: translateY(-2px);
      box-shadow:
        0 4px 12px rgba(88, 166, 255, 0.15),
        0 0 0 1px rgba(88, 166, 255, 0.08) inset;
    }

    .c0de-hero__chip:active {
      transform: translateY(0);
      transition-duration: 0.1s;
    }

    /* ------------------------------------------------------------------
     * Inline code, message text rendering
     * ------------------------------------------------------------------ */
    .c0de-inline-code {
      font-family: var(--haze-font-mono);
      background: rgba(88, 166, 255, 0.08);
      border: 1px solid rgba(88, 166, 255, 0.15);
      border-radius: 5px;
      padding: 2px 7px;
      font-size: 0.9em;
      color: #a5d6ff;
    }

    .c0de-msg-text {
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .c0de-msg-text > p {
      margin: 0 0 8px 0;
    }

    .c0de-msg-text > p:last-child {
      margin-bottom: 0;
    }

    .c0de-msg-text h1,
    .c0de-msg-text h2,
    .c0de-msg-text h3,
    .c0de-msg-text h4 {
      margin: 12px 0 8px 0;
      font-weight: 600;
      line-height: 1.3;
    }

    .c0de-msg-text h1 { font-size: 20px; }
    .c0de-msg-text h2 { font-size: 18px; }
    .c0de-msg-text h3 { font-size: 16px; }
    .c0de-msg-text h4 { font-size: 15px; }

    .c0de-msg-text ul,
    .c0de-msg-text ol {
      margin: 8px 0;
      padding-left: 24px;
    }

    .c0de-msg-text li {
      margin: 4px 0;
    }

    .c0de-msg-text strong {
      font-weight: 600;
      color: #fff;
      text-shadow: 0 0 20px rgba(255, 255, 255, 0.1);
    }

    .c0de-msg-text em {
      font-style: italic;
    }

    .c0de-msg-text a {
      color: var(--haze-color-primary);
      text-decoration: none;
    }

    .c0de-msg-text a:hover {
      text-decoration: underline;
    }

    .c0de-msg-text blockquote {
      margin: 8px 0;
      padding: 8px 14px;
      border-left: 3px solid var(--haze-color-primary);
      color: var(--haze-color-text-muted);
      background: rgba(88, 166, 255, 0.04);
      border-radius: 0 6px 6px 0;
    }

    .c0de-msg-text hr {
      border: none;
      border-top: 1px solid var(--haze-color-border);
      margin: 12px 0;
    }

    /* ------------------------------------------------------------------
     * Thinking indicator — streaming thinking text shown below the
     * ThinkingIndicator animation dots.
     * ------------------------------------------------------------------ */
    .c0de-thinking-text {
      display: block;
      font-size: var(--haze-text-xs);
      color: var(--haze-color-text-muted);
      margin-top: 4px;
      max-height: 80px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      opacity: 0.7;
    }
  }
`;
