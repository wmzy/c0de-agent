import { css } from '@linaria/core'
import type { ReactNode } from 'react'
import {
  BashIcon,
  BrainIcon,
  EditIcon,
  GlobIcon,
  GrepIcon,
  ReadIcon,
  SparkleIcon,
  ToolIcon,
  UserIcon,
  WriteIcon,
} from './icons.js'
import type { RenderBlock } from './utils/normalizeParts.js'

const wrap = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 28px;
  flex-shrink: 0;
  color: var(--text-secondary);
`

const iconWrap = css`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 24px;
`

const bar = css`
  flex: 1;
  width: 2px;
  min-height: 8px;
  margin-top: 2px;
  background: var(--border);
`

const TOOL_ICONS: Record<string, (p: Record<string, unknown>) => ReactNode> = {
  read: ReadIcon,
  write: WriteIcon,
  edit: EditIcon,
  bash: BashIcon,
  grep: GrepIcon,
  glob: GlobIcon,
}

export function PartDecoration({ block }: { block: RenderBlock }) {
  let iconName: string
  let icon: ReactNode

  switch (block.type) {
    case 'text':
      if (block.role === 'user') {
        iconName = 'user'
        icon = <UserIcon />
      } else {
        iconName = 'assistant'
        icon = <SparkleIcon />
      }
      break
    case 'thinking':
      iconName = 'brain'
      icon = <BrainIcon />
      break
    case 'steering':
      iconName = 'user'
      icon = <UserIcon />
      break
    case 'tool': {
      iconName = TOOL_ICONS[block.tool] ? block.tool : 'tool'
      const Icon = TOOL_ICONS[block.tool] ?? ToolIcon
      icon = <Icon />
      break
    }
  }

  return (
    <div className={wrap} data-testid="decoration" data-icon={iconName}>
      <div className={iconWrap}>{icon}</div>
      <div className={bar} />
    </div>
  )
}
