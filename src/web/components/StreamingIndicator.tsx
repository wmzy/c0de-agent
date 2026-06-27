import { css } from '@linaria/core'

const dot = css`
  display: inline-block;
  width: 6px;
  height: 6px;
  margin: 0 2px;
  border-radius: 50%;
  background: var(--text-secondary);
  animation: blink 1.4s infinite both;
  @keyframes blink {
    0%,
    80%,
    100% {
      opacity: 0.2;
    }
    40% {
      opacity: 1;
    }
  }
`

export function StreamingIndicator() {
  return (
    <span data-testid="streaming" role="status" aria-label="正在输入">
      <span className={dot} />
      <span className={dot} style={{ animationDelay: '0.2s' }} />
      <span className={dot} style={{ animationDelay: '0.4s' }} />
    </span>
  )
}
