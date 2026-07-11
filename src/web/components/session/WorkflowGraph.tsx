import { css } from '@linaria/core'

/** 工作流节点状态。 */
export type WorkflowNodeStatus = 'pending' | 'running' | 'completed' | 'failed'

/** 工作流图中的一个节点（子 agent 任务）。 */
export type WorkflowNode = {
  id: string
  agentType: string
  label: string
  status: WorkflowNodeStatus
}

// ── 布局 ──

const graphWrap = css`
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 8px 0;
`

const rootNode = css`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  align-self: flex-start;
`

const connector = css`
  width: 2px;
  height: 16px;
  background: var(--border);
  align-self: flex-start;
  margin-left: 20px;
`

const branchLine = css`
  position: relative;
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  padding-left: 12px;
  border-left: 2px solid var(--border);
`

const nodeWrap = css`
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
`

const nodeCard = css`
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  min-width: 140px;
  max-width: 280px;
  transition: border-color 0.2s, box-shadow 0.2s;
`

const nodeLabel = css`
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const nodeMeta = css`
  font-size: 11px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
`

// ── Phase 进度条 ──

const phaseBar = css`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 0 8px 0;
  flex-wrap: wrap;
`

const phaseItem = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
`

const phaseItemActive = css`
  border-color: var(--primary, #4a9eff);
  color: var(--primary, #4a9eff);
  font-weight: 600;
`

const phaseItemDone = css`
  color: var(--success, #22c55e);
  border-color: var(--success, #22c55e);
`

const phaseArrow = css`
  color: var(--text-secondary);
  font-size: 11px;
`

// ── 状态样式 ──

const statusColors: Record<WorkflowNodeStatus, { border: string; dot: string; text: string }> = {
  pending: {
    border: 'var(--border)',
    dot: 'var(--text-secondary)',
    text: 'var(--text-secondary)',
  },
  running: {
    border: 'var(--primary, #4a9eff)',
    dot: 'var(--primary, #4a9eff)',
    text: 'var(--primary, #4a9eff)',
  },
  completed: {
    border: 'var(--success, #22c55e)',
    dot: 'var(--success, #22c55e)',
    text: 'var(--success, #22c55e)',
  },
  failed: {
    border: 'var(--error, #ef4444)',
    dot: 'var(--error, #ef4444)',
    text: 'var(--error, #ef4444)',
  },
}

const STATUS_ICON: Record<WorkflowNodeStatus, string> = {
  pending: '○',
  running: '◐',
  completed: '✓',
  failed: '✗',
}

const STATUS_LABEL: Record<WorkflowNodeStatus, string> = {
  pending: '待执行',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
}

const dotBase = css`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
`

const dotPulse = css`
  animation: wf-pulse 1.2s ease-in-out infinite;
  @keyframes wf-pulse {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.4;
      transform: scale(0.75);
    }
  }
`

/** 状态指示点（带脉冲动画 for running）。 */
function StatusDot({ status }: { status: WorkflowNodeStatus }) {
  const color = statusColors[status]
  return (
    <span
      className={`${dotBase}${status === 'running' ? ` ${dotPulse}` : ''}`}
      style={{ background: color.dot }}
      data-testid={`wf-dot-${status}`}
    />
  )
}

function PhaseBar({
  phases,
  currentPhase,
}: {
  phases: string[]
  currentPhase?: string
}) {
  const currentIdx = currentPhase ? phases.indexOf(currentPhase) : -1
  return (
    <div className={phaseBar} data-testid="wf-phases">
      {phases.map((phase, i) => {
        const isDone = i < currentIdx
        const isActive = phase === currentPhase
        const cls = `${phaseItem}${isActive ? ` ${phaseItemActive}` : ''}${isDone ? ` ${phaseItemDone}` : ''}`
        const icon = isDone ? '\u2713' : isActive ? '\u25D0' : '\u25CB'
        return (
          <div key={phase} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span className={cls}>
              {icon} {phase}
            </span>
            {i < phases.length - 1 && <span className={phaseArrow}>&rarr;</span>}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 工作流图可视化组件。
 *
 * 轻量级 CSS 树形布局（无外部依赖）：
 *  - 根节点（主 agent / dispatch 类型）在顶部
 *  - 子节点（批量任务）在下方水平排列，用左侧竖线连接
 *  - 每个节点显示 agentType、label、状态指示点
 *
 * 用于 TaskToolView（task 工具渲染）和未来可能的独立工作流面板。
 */
export function WorkflowGraph({
  nodes,
  rootLabel,
  rootStatus = 'completed',
  phases,
  currentPhase,
}: {
  nodes: WorkflowNode[]
  rootLabel: string
  rootStatus?: WorkflowNodeStatus
  phases?: string[]
  currentPhase?: string
}) {
  if (nodes.length === 0 && !phases) return null

  const rootColor = statusColors[rootStatus]

  return (
    <div className={graphWrap} data-testid="workflow-graph">
      {/* 根节点 */}
      <div
        className={rootNode}
        style={{
          borderColor: rootColor.border,
          color: rootColor.text,
        }}
      >
        <StatusDot status={rootStatus} />
        <span>{rootLabel}</span>
        <span style={{ fontSize: 11, opacity: 0.7 }}>dispatcher</span>
      </div>

      {/* Phase 进度条 */}
      {phases && phases.length > 0 && (
        <PhaseBar phases={phases} currentPhase={currentPhase} />
      )}

      {/* 连接线 */}
      {nodes.length > 0 && <div className={connector} />}

      {/* 子节点分支 */}
      {nodes.length > 0 && (
        <div className={branchLine}>
          {nodes.map((node) => {
            const color = statusColors[node.status]
            return (
              <div key={node.id} className={nodeWrap}>
                <div
                  className={nodeCard}
                  style={{
                    borderColor: color.border,
                    boxShadow: node.status === 'running' ? `0 0 0 1px ${color.border}` : 'none',
                  }}
                >
                  <div className={nodeLabel}>{node.label}</div>
                  <div className={nodeMeta}>
                    <StatusDot status={node.status} />
                    <span style={{ color: color.text }}>
                      {STATUS_ICON[node.status]} {node.agentType} · {STATUS_LABEL[node.status]}
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 构建工作流节点列表的工具函数（供外部组件调用）。 */
export function buildWorkflowNodes(
  tasks: Array<{ assignment?: string; description?: string; role?: string }>,
  agentType: string,
  status: WorkflowNodeStatus,
): WorkflowNode[] {
  return tasks.map((task, i) => ({
    id: `task-${i}`,
    agentType,
    label: task.description ?? task.role ?? `Task ${i + 1}`,
    status,
  }))
}
