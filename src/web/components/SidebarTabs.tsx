import { css } from '@linaria/core'
import type { ReactNode } from 'react'

export type SidebarTab = 'sessions' | 'files'

const container = css`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
`

const tabBar = css`
  display: flex;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
`

const tab = css`
  flex: 1;
  padding: 6px 8px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    color: var(--text);
  }
`

const tabActive = css`
  color: var(--primary);
  border-bottom-color: var(--primary);
`

const content = css`
  flex: 1;
  overflow: auto;
  min-height: 0;
`

type SidebarTabsProps = {
  activeTab: SidebarTab
  onSwitch: (t: SidebarTab) => void
  sessions: ReactNode
  files: ReactNode
}

/** 会话/文件侧栏切换器：顶部两 tab，下方渲染对应内容。 */
export function SidebarTabs({ activeTab, onSwitch, sessions, files }: SidebarTabsProps) {
  return (
    <div className={container}>
      <div className={tabBar}>
        <button
          type="button"
          className={`${tab} ${activeTab === 'sessions' ? tabActive : ''}`}
          onClick={() => onSwitch('sessions')}
          data-testid="tab-sessions"
        >
          💬会话
        </button>
        <button
          type="button"
          className={`${tab} ${activeTab === 'files' ? tabActive : ''}`}
          onClick={() => onSwitch('files')}
          data-testid="tab-files"
        >
          📁文件
        </button>

      </div>
      <div className={content}>
        {activeTab === 'sessions' ? sessions : files}
      </div>
    </div>
  )
}
