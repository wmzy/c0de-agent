import { css } from '@linaria/core'

const dock = css`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
  font-size: 13px;
`

const info = css`
  flex: 1;
  min-width: 0;
  & strong {
    color: var(--accent, #4a9eff);
  }
  & pre {
    margin: 4px 0 0;
    max-height: 80px;
    overflow: auto;
    font-size: 11px;
    opacity: 0.8;
  }
`

const actions = css`
  display: flex;
  gap: 8px;
  flex-shrink: 0;
`

const btn = css`
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
  &:hover {
    background: var(--bg-secondary);
  }
`

const approve = css`
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--accent, #4a9eff);
  background: var(--bg);
  color: var(--accent, #4a9eff);
  cursor: pointer;
  font-size: 12px;
  &:hover {
    background: var(--bg-secondary);
  }
`

type Props = {
  tool: string
  input: unknown
  onConfirm: () => void
  onCancel: () => void
}

function PermissionDock(props: Props) {
  return (
    <div className={dock} data-testid="permission-dock">
      <div className={info}>
        工具 <strong>{props.tool}</strong> 请求执行：
        <pre>{JSON.stringify(props.input, null, 2)}</pre>
      </div>
      <div className={actions}>
        <button className={btn} onClick={props.onCancel} type="button">
          拒绝
        </button>
        <button className={approve} onClick={props.onConfirm} type="button" data-testid="approve">
          允许
        </button>
      </div>
    </div>
  )
}

export { PermissionDock }
