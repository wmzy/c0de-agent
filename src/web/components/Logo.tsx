import { css } from '@linaria/core'

const wrap = css`
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-weight: 700;
  font-size: 14px;
  letter-spacing: -0.01em;
  color: var(--text);
`

const mark = css`
  display: block;
  flex-shrink: 0;
`

/** wordmark 隐藏时保留读屏可及的品牌名（视觉上只剩图标）。 */
const srOnly = css`
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
`

/** c0de-agent 品牌 logo：终端提示符 mark + wordmark。
 *  mark 用主题色变量自适应明暗主题；wordmark 跟随正文文本色。
 *  wordmark=false 时仅显示 mark（如顶栏，避免与项目切换器的项目名字样重复相邻），
 *  品牌名以 sr-only 文本保留给读屏。 */
export function Logo({ wordmark = true }: { wordmark?: boolean }) {
  return (
    <span className={wrap}>
      <svg
        className={mark}
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id="c0de-logo-grad"
            x1="2"
            y1="2"
            x2="22"
            y2="22"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="var(--primary)" />
            <stop offset="1" stopColor="var(--primary-hover)" />
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="20" height="20" rx="6" fill="url(#c0de-logo-grad)" />
        <path
          d="M8 8.5 L12.5 12 L8 15.5"
          stroke="#fff"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="15.5" cy="12" r="3" fill="#fff" opacity="0.22" />
        <circle cx="15.5" cy="12" r="1.5" fill="#fff" />
      </svg>
      {wordmark ? 'c0de-agent' : <span className={srOnly}>c0de-agent</span>}
    </span>
  )
}
