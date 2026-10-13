import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { ToolError, toolErrorText } from '@/components/session/tools/toolError.js'
import { WorkflowGraph, type WorkflowNode } from '@/components/session/WorkflowGraph.js'

const wrapper = css`
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const metaLabel = css`
  font-size: 12px;
  color: var(--haze-color-text-secondary);
`

const outputPre = css`
  margin: 0;
  padding: 8px;
  background: var(--haze-color-bg-muted);
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

/** 批量模式下每个子任务的终态（由 task 工具写进 metadata.subtasks）。 */
type SubtaskStatus = { index: number; status: 'completed' | 'failed' | 'running' }

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

  // 逐子任务状态（有则用之）。批量里失败一个不再把成功的也画成失败；
  // 旧的历史消息没有 metadata，回落到父工具状态（保持原行为）。
  const meta = (output as { metadata?: { subtasks?: SubtaskStatus[] } } | undefined)?.metadata
  const byIndex = new Map<number, SubtaskStatus['status']>()
  if (Array.isArray(meta?.subtasks)) {
    for (const s of meta.subtasks) byIndex.set(s.index, s.status)
  }
  const nodeStatus = (i: number): WorkflowNode['status'] => {
    const own = byIndex.get(i)
    return own ? mapSubtaskStatus(own) : mapStatus(status)
  }

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
        status: nodeStatus(i),
      })
    }
  } else if (inp.prompt) {
    // 单任务模式
    nodes.push({
      id: 'task-0',
      agentType,
      label: inp.description ?? inp.prompt.slice(0, 60),
      status: nodeStatus(0),
    })
  }

  // 输出文本：失败不再混进中性灰的 Output 区——否则「失败」与「成功输出」同形，
  // 且 error 为空白串时整个工具体只剩工作流图、一个字的失败原因都没有。
  const errorText = toolErrorText(output, status)
  const resultText = output?._tag === 'success' || output?._tag === 'truncated' ? output.output : ''

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
      {errorText !== null ? (
        <ToolError output={output} status={status} />
      ) : (
        resultText && (
          <div>
            <div className={metaLabel}>Output</div>
            <pre className={outputPre} data-testid="task-output">
              {resultText}
            </pre>
          </div>
        )
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

/** 子任务自身终态 → 工作流节点状态。 */
function mapSubtaskStatus(subtask: SubtaskStatus['status']): WorkflowNode['status'] {
  switch (subtask) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'running':
      return 'running'
  }
}
