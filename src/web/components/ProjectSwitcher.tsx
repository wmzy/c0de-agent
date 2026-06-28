import { css } from '@linaria/core'
import type { Project } from '../types/index.js'

const select = css`
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  &:hover {
    border-color: var(--primary);
  }
  &:focus {
    outline: none;
    border-color: var(--primary);
  }
`

/** ALL = 显示全部会话；null = 未关联项目的会话；其余 = 具体项目 id。 */
type Selection = 'ALL' | 'UNASSIGNED' | string

type ProjectSwitcherProps = {
  projects: Project[]
  /** 当前选中值。 */
  value: Selection
  onChange: (value: Selection) => void
}

/** 会话列表的项目过滤切换器。 */
export function ProjectSwitcher({ projects, value, onChange }: ProjectSwitcherProps) {
  return (
    <select
      className={select}
      value={value}
      onChange={(e) => onChange(e.target.value as Selection)}
      data-testid="project-switcher"
      aria-label="按项目筛选会话"
    >
      <option value="ALL">全部项目</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name ?? '未命名项目'}
        </option>
      ))}
      <option value="UNASSIGNED">未关联项目</option>
    </select>
  )
}

export type { ProjectSwitcherProps, Selection }
