import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { WorkflowGraph, type WorkflowNode } from '../WorkflowGraph.js'

const wrapper = css`
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const metaLabel = css`
  font-size: 12px;
  color: var(--text-secondary);
`

const outputPre = css`
  margin: 0;
  padding: 8px;
  background: var(--code-bg);
  border-radius: 6px;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 300px;
`

/** task 工具输入类型（单任务 / 批量）。 */
type TaskToolInput = {
  subagent_type?: string
  prompt?: string
  description?: string
  context?: string
  tasks?: Array<{ assignment?: string; description?: string; role?: string; prompt?: string }>
}

/**
 * task 工具自定义渲染：展示工作流图 + 输出。
 *
 * 批量模式（context + tasks[]）：构建多节点工作流图。
 * 单任务模式（prompt）：单节点图。
 */
export function TaskToolView({
  input,
  output,
  status,
}: {
  input: unknown
  output?: ToolResult
  status: string
}) {
  const inp = (input ?? {}) as TaskToolInput
  const agentType = inp.subagent_type ?? 'general'

  // 构建工作流节点
  const nodes: WorkflowNode[] = []

  if (Array.isArray(inp.tasks) && inp.tasks.length > 0) {
    // 批量模式
    for (let i = 0; i < inp.tasks.length; i++) {
      const task = inp.tasks[i]
      if (!task) continue
      nodes.push({
        id: `task-${i}`,
        agentType,
        label: task.description ?? task.role ?? `Task ${i + 1}`,
        status: mapStatus(status),
      })
    }
  } else if (inp.prompt) {
    // 单任务模式
    nodes.push({
      id: 'task-0',
      agentType,
      label: inp.description ?? inp.prompt.slice(0, 60),
      status: mapStatus(status),
    })
  }

  // 输出文本
  const resultText =
    output?._tag === 'success' || output?._tag === 'truncated'
      ? output.output
      : output?._tag === 'error'
        ? output.error
        : ''

  return (
    <div className={wrapper} data-testid="task-tool-view">
      {inp.context && (
        <details>
          <summary className={metaLabel}>Shared Context</summary>
          <pre className={outputPre}>{inp.context}</pre>
        </details>
      )}
      {nodes.length > 0 && (
        <WorkflowGraph nodes={nodes} rootLabel={agentType} rootStatus={mapStatus(status)} />
      )}
      {resultText && (
        <div>
          <div className={metaLabel}>Output</div>
          <pre className={outputPre} data-testid="task-output">
            {resultText}
          </pre>
        </div>
      )}
    </div>
  )
}

/** 把 ToolBlock 状态映射到工作流节点状态。 */
function mapStatus(toolStatus: string): WorkflowNode['status'] {
  switch (toolStatus) {
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'error':
      return 'failed'
    default:
      return 'pending'
  }
}
