import { css } from '@linaria/core'

const overlay = css`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
`

const dialog = css`
  background: var(--bg);
  border-radius: 8px;
  padding: 20px;
  max-width: 400px;
  box-shadow: var(--shadow);
`

export function PermissionDialog({
  tool,
  input,
  onConfirm,
  onCancel,
}: {
  tool: string
  input: unknown
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className={overlay} role="dialog" aria-modal="true" data-testid="permission-dialog">
      <div className={dialog}>
        <h3>权限确认</h3>
        <p>
          工具 <strong>{tool}</strong> 请求执行：
        </p>
        <pre style={{ maxHeight: '200px', overflow: 'auto' }}>{JSON.stringify(input, null, 2)}</pre>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} type="button">
            拒绝
          </button>
          <button onClick={onConfirm} type="button" data-testid="approve">
            允许
          </button>
        </div>
      </div>
    </div>
  )
}
