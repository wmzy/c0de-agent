import { css } from '@linaria/core'
import { useState } from 'react'

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
  align-items: center;
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

const allowAlways = css`
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
  & input {
    min-height: auto;
    min-width: auto;
    margin: 0;
  }
`

type Props = {
  tool: string
  input: unknown
  /** 允许「本会话始终允许」勾选（仅会话级 dock；全局/草稿页不提供）。 */
  allowAlways?: boolean
  onConfirm: (alwaysAllow: boolean) => void
  onCancel: () => void
}

function PermissionDock(props: Props) {
  const [alwaysAllow, setAlwaysAllow] = useState(false)
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
        <button
          className={approve}
          onClick={() => props.onConfirm(alwaysAllow)}
          type="button"
          data-testid="approve"
        >
          允许
        </button>
        {props.allowAlways && (
          <label className={allowAlways}>
            <input
              type="checkbox"
              checked={alwaysAllow}
              onChange={(e) => setAlwaysAllow(e.target.checked)}
              data-testid="allow-always-checkbox"
            />
            本会话始终允许 {props.tool}
          </label>
        )}
      </div>
    </div>
  )
}

export { PermissionDock }
