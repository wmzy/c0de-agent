// src/web/components/settings/WorkflowsPanel.tsx
// 设置页工作流管理面板：列表 / 查看源码 / 新建 / 编辑 / 删除。
// 此前 Web 端只有补全 popover 的 list 消费，创建/删除能力在 REST/斜杠孤岛——补齐管理入口。

import { css } from '@linaria/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { WorkflowInfo } from '../../services/workflows.js'
import { workflowsAPI } from '../../services/workflows.js'
import { DangerConfirmDialog } from '../DangerConfirmDialog.js'
import { Dialog } from '../Dialog.js'
import { field, fieldInput, hint, section, sectionTitle } from './styles.js'

const row = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
  font-size: 13px;

  &:last-child {
    border-bottom: none;
  }
`

const rowMain = css`
  flex: 1;
  min-width: 0;
`

const rowName = css`
  font-weight: 500;
  color: var(--text);
`

const rowDesc = css`
  color: var(--text-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const badge = css`
  flex-shrink: 0;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 10px;
  color: var(--text-secondary);
`

const overrideBadge = css`
  flex-shrink: 0;
  padding: 1px 6px;
  border: 1px solid var(--primary);
  border-radius: 4px;
  font-size: 10px;
  color: var(--primary);
`

const actionBtn = css`
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  padding: 3px 8px;
  min-height: auto;
  cursor: pointer;

  &:hover:not(:disabled) {
    color: var(--text);
  }

  &:disabled {
    opacity: 0.45;
    cursor: default;
  }
`

const dangerAction = css`
  color: var(--error);

  &:hover:not(:disabled) {
    color: var(--error);
  }
`

const editorArea = css`
  width: 100%;
  min-height: 260px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  box-sizing: border-box;

  &:focus {
    outline: none;
    border-color: var(--primary);
  }
`

const errorText = css`
  color: var(--error);
  font-size: 12px;
  margin-top: 8px;
`

const WORKFLOW_NAME_RE = /^[a-z0-9-]+$/

/** 新建工作流的起始模板（与 prompt-registry 的工作流格式提示同构）。 */
const NEW_WORKFLOW_TEMPLATE = `export const meta = {
  name: 'my-workflow',          // 小写 kebab-case，与文件名一致
  description: '描述这个工作流做什么',
  phases: ['step1', 'step2'],
  // timeout: 300,               // 可选：秒，超时中止执行
}

export default async function workflow(ctx) {
  const { runSubagents, utils, progress, args } = ctx

  progress('开始...')
  // 可用：ctx.runSubagent(type, { assignment, description, model })
  //      ctx.runSubagents(type, [{ assignment, description, role }], context)
  //      ctx.utils.glob / grep / read / splitByDirectory
  return { output: '完成' }
}
`

function sourceLabel(source: string): string {
  switch (source) {
    case 'builtin':
      return '内置'
    case 'user':
      return '用户'
    case 'project':
      return '项目'
    default:
      return source
  }
}

function errMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    return String((e as { message: unknown }).message)
  }
  return '未知错误'
}

type EditorState =
  | { mode: 'view'; name: string; readOnly: true }
  | { mode: 'create' }
  | { mode: 'edit'; name: string; source: 'user' | 'project' }

type WorkflowsPanelProps = {
  projectId?: string
}

function WorkflowsPanel({ projectId }: WorkflowsPanelProps) {
  const qc = useQueryClient()
  const queryKey = ['workflows', projectId]
  const { data } = useQuery({
    queryKey,
    queryFn: () => workflowsAPI.list(projectId),
    staleTime: 30_000,
  })
  const workflows = data?.workflows ?? []
  const trustRequired = data?.trustRequired

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftSource, setDraftSource] = useState('')
  const [draftTarget, setDraftTarget] = useState<'project' | 'user'>('project')
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<WorkflowInfo | null>(null)

  const invalidate = () => void qc.invalidateQueries({ queryKey })

  const saveMut = useMutation({
    mutationFn: workflowsAPI.save,
    onSuccess: () => {
      invalidate()
      setEditor(null)
    },
    onError: (e) => setError(errMessage(e)),
  })

  const removeMut = useMutation({
    mutationFn: ({ name, target }: { name: string; target: 'project' | 'user' }) =>
      workflowsAPI.remove(name, projectId, target),
    onSuccess: () => {
      invalidate()
      setPendingDelete(null)
    },
    onError: (e) => setError(errMessage(e)),
  })

  const openCreate = () => {
    setError(null)
    setDraftName('')
    setDraftSource(NEW_WORKFLOW_TEMPLATE)
    setDraftTarget(projectId ? 'project' : 'user')
    setEditor({ mode: 'create' })
  }

  const openView = async (name: string) => {
    setError(null)
    setEditor({ mode: 'view', name, readOnly: true })
    try {
      const detail = await workflowsAPI.get(name, projectId)
      setDraftName(detail.name)
      setDraftSource(detail.sourceCode)
    } catch (e) {
      setError(errMessage(e))
      setEditor(null)
    }
  }

  const openEdit = async (wf: WorkflowInfo) => {
    setError(null)
    setDraftTarget(wf.source === 'user' ? 'user' : 'project')
    setEditor({ mode: 'edit', name: wf.name, source: wf.source === 'user' ? 'user' : 'project' })
    try {
      const detail = await workflowsAPI.get(wf.name, projectId)
      setDraftName(detail.name)
      setDraftSource(detail.sourceCode)
    } catch (e) {
      setError(errMessage(e))
      setEditor(null)
    }
  }

  const submitSave = () => {
    if (!editor) return
    const name = draftName.trim()
    if (!WORKFLOW_NAME_RE.test(name)) {
      setError(`名称 "${name}" 不合法：仅小写字母、数字、连字符（[a-z0-9-]+）`)
      return
    }
    if (!draftSource.trim()) {
      setError('源码不能为空')
      return
    }
    setError(null)
    saveMut.mutate({
      name,
      source: draftSource,
      target: draftTarget,
      // 编辑模式覆盖同名文件是用户显式意图（对话框标题即「编辑：name」）；
      // 新建模式不带 overwrite——同名时服务端 409 并提示既有层级，防误覆盖。
      ...(editor.mode === 'edit' ? { overwrite: true } : {}),
      ...(draftTarget === 'project' && projectId ? { projectId } : {}),
    })
  }

  return (
    <div className={section}>
      <h2 className={sectionTitle}>工作流</h2>
      {error && !editor ? (
        <div className={errorText} data-testid="workflow-panel-error">
          {error}
        </div>
      ) : null}
      {trustRequired ? (
        <div className={hint} data-testid="workflow-trust-required">
          项目未信任（或信任后配置漂移）：项目级工作流（.c0de/workflows/）已被隐藏。
          信任该项目后可在聊天中列出与运行。
        </div>
      ) : null}
      {workflows.length === 0 ? (
        <div className={hint}>
          暂无工作流。新建一个工作流脚本后可在聊天中用 /workflow run 执行。
        </div>
      ) : (
        workflows.map((wf) => (
          <div key={wf.name} className={row} data-testid="workflow-row">
            <div className={rowMain}>
              <div className={rowName}>{wf.name}</div>
              <div className={rowDesc}>{wf.description}</div>
            </div>
            <span className={badge}>{sourceLabel(wf.source)}</span>
            {wf.overrides ? (
              <span className={overrideBadge}>
                覆盖{wf.overrides === 'builtin' ? '内置' : '用户'}
              </span>
            ) : null}
            <button
              type="button"
              className={actionBtn}
              onClick={() => void openView(wf.name)}
              data-testid="workflow-view"
            >
              查看
            </button>
            {wf.source !== 'builtin' ? (
              <>
                <button
                  type="button"
                  className={actionBtn}
                  onClick={() => void openEdit(wf)}
                  data-testid="workflow-edit"
                >
                  编辑
                </button>
                <button
                  type="button"
                  className={`${actionBtn} ${dangerAction}`}
                  onClick={() => setPendingDelete(wf)}
                  data-testid="workflow-delete"
                >
                  删除
                </button>
              </>
            ) : null}
          </div>
        ))
      )}
      <button type="button" className={actionBtn} onClick={openCreate} data-testid="workflow-add">
        + 新建工作流
      </button>
      <div className={hint}>
        项目级工作流写入 .c0de/workflows/（随仓库分发，受项目信任门禁保护）；用户级写入
        ~/.c0de/workflows/。
      </div>

      {editor ? (
        <Dialog
          open
          onClose={() => setEditor(null)}
          title={
            editor.mode === 'create'
              ? '新建工作流'
              : editor.mode === 'view'
                ? `查看：${editor.name}`
                : `编辑：${editor.name}`
          }
          testId="workflow-dialog"
          footer={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {editor.mode === 'view' ? (
                <button type="button" onClick={() => setEditor(null)}>
                  关闭
                </button>
              ) : (
                <>
                  <button type="button" onClick={() => setEditor(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={submitSave}
                    disabled={saveMut.isPending}
                    data-testid="workflow-save"
                  >
                    {saveMut.isPending ? '保存中…' : '保存'}
                  </button>
                </>
              )}
            </div>
          }
        >
          <div className={field}>
            <span>名称</span>
            <input
              className={fieldInput}
              value={draftName}
              disabled={editor.mode !== 'create'}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="my-workflow"
              data-testid="workflow-name-input"
            />
          </div>
          {editor.mode === 'create' ? (
            <div className={field}>
              <span>保存到</span>
              <select
                value={draftTarget}
                onChange={(e) => setDraftTarget(e.target.value as 'project' | 'user')}
                data-testid="workflow-target-select"
              >
                {projectId ? <option value="project">当前项目</option> : null}
                <option value="user">全局（用户级）</option>
              </select>
            </div>
          ) : null}
          <textarea
            className={editorArea}
            value={draftSource}
            readOnly={editor.mode === 'view'}
            onChange={(e) => setDraftSource(e.target.value)}
            spellCheck={false}
            data-testid="workflow-source-editor"
          />
          {error ? (
            <div className={errorText} data-testid="workflow-panel-error">
              {error}
            </div>
          ) : null}
        </Dialog>
      ) : null}

      <DangerConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete ? `删除工作流 ${pendingDelete.name}` : '删除工作流'}
        description="工作流文件将被永久删除（不可恢复；项目级文件位于 .c0de/workflows/）。"
        confirmWord={pendingDelete?.name ?? ''}
        confirmLabel="删除"
        busy={removeMut.isPending}
        onConfirm={() => {
          if (pendingDelete) {
            removeMut.mutate({
              name: pendingDelete.name,
              // 按行来源显式指定删除层级：用户级条目永远删用户级文件，绝不因
              // 项目文件缺失/竞态回退到另一层级。
              target: pendingDelete.source === 'user' ? 'user' : 'project',
            })
          }
        }}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  )
}

export { WorkflowsPanel }
