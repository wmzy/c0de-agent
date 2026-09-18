import { css } from '@linaria/core'
import { SyncedSelect } from '@/components/SyncedControls.js'
import { inputStyle } from '@/styles/tokens.js'
import type { Project } from '@/types/index.js'

const select = css`
  width: 100%;
  padding: 6px 8px;
  font-size: 13px;
  cursor: pointer;
  &:hover {
    border-color: var(--haze-color-primary);
  }
  &:focus {
    outline: none;
    border-color: var(--haze-color-primary);
  }
`

type ProjectSwitcherProps = {
  projects: Project[]
  /** 当前项目 id（来自路由，恒有值）。 */
  value: string
  /** 切换项目。 */
  onChange: (projectId: string) => void
}

/** 项目导航器：选择项目即切换到该项目的会话视图（项目为路由顶级维度）。 */
export function ProjectSwitcher({ projects, value, onChange }: ProjectSwitcherProps) {
  return (
    <SyncedSelect
      className={`${inputStyle} ${select}`}
      value={value}
      onValuesChange={(v) => onChange(v as string)}
      data-testid="project-switcher"
      aria-label="切换项目"
    >
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name ?? '未命名项目'}
        </option>
      ))}
    </SyncedSelect>
  )
}

export type { ProjectSwitcherProps }
