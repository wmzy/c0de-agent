// src/web/components/settings/SettingsChrome.tsx
// Settings 页面的工具栏 / 角色路由 / 吸底保存条，从 views/Settings.tsx 拆出（2026-09）。
// 均为受控展示组件，样式与 data-testid 保持不变。

import { css } from '@linaria/core'
import type { Config } from '@shared/types/config.js'
import type { RefObject } from 'react'
import { hint, hintMb, kvRow, section, sectionTitle } from './styles.js'

const toolbar = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  position: sticky;
  top: 0;
  z-index: 10;
  flex-wrap: wrap;
`

const toolbarTitle = css`
  font-size: 15px;
  font-weight: 600;
  margin-right: auto;
`

const segGroup = css`
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
`

const segBtn = css`
  padding: 4px 12px;
  border: none;
  border-right: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  &:last-child {
    border-right: none;
  }
`

const segBtnActive = css`
  background: var(--primary);
  color: #fff;
`

const toolBtn = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
  &:hover {
    background: var(--bg-secondary);
  }
`

/** 隐藏的 file input。 */
const hiddenInput = css`
  display: none;
`

/** 保存反馈 — 成功色。 */
const saveOk = css`
  color: var(--success, #2a9d8f);
`

/** 保存反馈 — 错误色。 */
const saveErr = css`
  color: var(--error, #e63946);
`

/** 保存状态提示文本。 */
const saveStatus = css`
  font-size: 0.9em;
`

/** 吸底保存条：sticky 于设置滚动容器底部；有未保存更改时强调，无更改时弱化。 */
const saveBar = css`
  position: sticky;
  bottom: 0;
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border);
  z-index: 10;
`

/** 有未保存更改时的强调：上浮阴影 + 主色分隔线。 */
const saveBarDirty = css`
  border-top-color: color-mix(in srgb, var(--primary) 40%, var(--border));
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.12);
`

/** 保存条中间弹性占位：提示靠左、按钮靠右。 */
const saveBarSpacer = css`
  flex: 1;
`

/** 「未保存更改」提示：警示色。 */
const dirtyHint = css`
  color: var(--warning);
  font-size: 13px;
`

type SaveFeedback =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'ok' }
  | { kind: 'err'; msg: string }

type SettingsToolbarProps = {
  viewMode: 'gui' | 'json'
  onSwitchGui: () => void
  onSwitchJson: () => void
  fileInputRef: RefObject<HTMLInputElement | null>
  onImport: (e: React.ChangeEvent<HTMLInputElement>) => void
  onExport: () => void
}

function SettingsToolbar({
  viewMode,
  onSwitchGui,
  onSwitchJson,
  fileInputRef,
  onImport,
  onExport,
}: SettingsToolbarProps) {
  return (
    <div className={toolbar}>
      <h1 className={toolbarTitle}>⚙ 设置</h1>
      <div className={segGroup}>
        <button
          type="button"
          className={`${segBtn} ${viewMode === 'gui' ? segBtnActive : ''}`}
          onClick={onSwitchGui}
          data-testid="settings-mode-gui"
        >
          表单
        </button>
        <button
          type="button"
          className={`${segBtn} ${viewMode === 'json' ? segBtnActive : ''}`}
          onClick={onSwitchJson}
          data-testid="settings-mode-json"
        >
          {'{ } JSON'}
        </button>
      </div>
      <button
        type="button"
        className={toolBtn}
        onClick={() => fileInputRef.current?.click()}
        data-testid="settings-import"
        title="从 JSON 文件导入配置"
      >
        ⬆ 导入
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className={hiddenInput}
        onChange={onImport}
        data-testid="settings-import-input"
      />
      <button
        type="button"
        className={toolBtn}
        onClick={onExport}
        data-testid="settings-export"
        title="导出当前配置为 JSON 文件"
      >
        ⬇ 导出
      </button>
    </div>
  )
}

type RoleRoutingSectionProps = {
  routing: Config['roleRouting']
  onRename: (oldKey: string, newKey: string) => void
  onUpdate: (role: string, field: 'provider' | 'model', value: string) => void
  onRemove: (role: string) => void
  onAdd: () => void
}

function RoleRoutingSection({
  routing,
  onRename,
  onUpdate,
  onRemove,
  onAdd,
}: RoleRoutingSectionProps) {
  return (
    <div className={section}>
      <h2 className={sectionTitle}>角色路由</h2>
      <div className={`${hint} ${hintMb}`}>
        为特定角色指定独立的 provider 和 model（覆盖默认）。
      </div>
      {Object.entries(routing ?? {}).map(([role, cfg]) => (
        <div key={role} className={kvRow}>
          <input
            value={role}
            placeholder="角色名"
            onChange={(e) => onRename(role, e.target.value)}
          />
          <input
            value={cfg.provider}
            placeholder="provider"
            onChange={(e) => onUpdate(role, 'provider', e.target.value)}
          />
          <input
            value={cfg.model}
            placeholder="model"
            onChange={(e) => onUpdate(role, 'model', e.target.value)}
          />
          <button type="button" data-variant="danger" onClick={() => onRemove(role)}>
            删除
          </button>
        </div>
      ))}
      <button type="button" onClick={onAdd} data-testid="role-add">
        + 添加角色
      </button>
    </div>
  )
}

type SettingsSaveBarProps = {
  isDirty: boolean
  feedback: SaveFeedback
  onDiscard: () => void
  onSave: () => void
}

function SettingsSaveBar({ isDirty, feedback, onDiscard, onSave }: SettingsSaveBarProps) {
  return (
    <div className={`${saveBar} ${isDirty ? saveBarDirty : ''}`} data-testid="settings-save-bar">
      {isDirty && (
        <span className={dirtyHint} data-testid="settings-dirty-hint">
          ● 未保存更改
        </span>
      )}
      {feedback.kind !== 'idle' && (
        <span
          className={`${saveStatus} ${
            feedback.kind === 'ok' ? saveOk : feedback.kind === 'err' ? saveErr : ''
          }`}
          data-testid="settings-save-status"
        >
          {feedback.kind === 'saving' && '保存中…'}
          {feedback.kind === 'ok' && '✓ 已保存'}
          {feedback.kind === 'err' && `✗ 保存失败：${feedback.msg}`}
        </span>
      )}
      <span className={saveBarSpacer} />
      {isDirty && (
        <button
          type="button"
          onClick={onDiscard}
          data-testid="settings-discard"
          title="放弃当前未保存的修改，恢复到已保存配置"
        >
          放弃更改
        </button>
      )}
      <button
        type="button"
        data-variant="primary"
        onClick={onSave}
        disabled={!isDirty || feedback.kind === 'saving'}
        title={isDirty ? '保存配置' : '配置未变更或正在加载'}
        data-testid="settings-save"
      >
        {feedback.kind === 'saving' ? '保存中…' : '保存'}
      </button>
    </div>
  )
}

export type { SaveFeedback }
export { RoleRoutingSection, SettingsSaveBar, SettingsToolbar }
