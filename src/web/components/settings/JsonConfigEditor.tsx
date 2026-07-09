import { css } from '@linaria/core'

const jsonWrap = css`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
`

const jsonTextarea = css`
  flex: 1;
  min-height: 420px;
  width: 100%;
  box-sizing: border-box;
  padding: 16px;
  border: none;
  background: var(--code-bg);
  color: var(--text);
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
  tab-size: 2;
  white-space: pre;
`

const jsonErrorBar = css`
  padding: 8px 16px;
  background: var(--diff-del-bg);
  color: var(--diff-del-text);
  font-size: 12px;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  word-break: break-all;
`

const jsonOkBar = css`
  padding: 6px 16px;
  background: var(--diff-add-bg);
  color: var(--diff-add-text);
  font-size: 12px;
`

interface JsonConfigEditorProps {
  jsonText: string
  jsonError: string | null
  /** 文本变更回调：实时解析由父组件完成（合法→同步 draft，非法→仅提示）。 */
  onChange: (text: string) => void
}

/** JSON 配置编辑器：textarea + 实时合法性提示条。 */
function JsonConfigEditor({ jsonText, jsonError, onChange }: JsonConfigEditorProps) {
  return (
    <div className={jsonWrap}>
      <textarea
        className={jsonTextarea}
        value={jsonText}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        data-testid="settings-json-editor"
      />
      {jsonError ? (
        <div className={jsonErrorBar} data-testid="settings-json-error">
          ⚠ {jsonError}
        </div>
      ) : (
        <div className={jsonOkBar}>✓ JSON 合法，编辑实时同步到配置草稿</div>
      )}
    </div>
  )
}

export { JsonConfigEditor }
