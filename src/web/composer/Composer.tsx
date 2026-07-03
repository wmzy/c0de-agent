import { css } from '@linaria/core'
import type { DragEvent, KeyboardEvent } from 'react'
import { useEffect, useState } from 'react'
import { useFileReferenceSetter } from '../contexts/ReferenceContext.js'
import { useCommands } from '../hooks/useCommands.js'
import { useFileSearch } from '../hooks/useFiles.js'
import type { AgentListItem } from '../services/agent.js'
import { AtFilePopover } from './AtFilePopover.js'
import { AttachmentBar } from './AttachmentBar.js'
import { ComposerEditor } from './ComposerEditor.js'
import { PermissionDock } from './PermissionDock.js'
import { SlashPopover } from './SlashPopover.js'
import type { ImagePart, Prompt } from './types.js'
import { promptToText } from './types.js'
import { useComposer } from './useComposer.js'

const wrap = css`
  position: relative;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border);
  background: var(--bg);
`

const editorRow = css`
  position: relative;
  display: flex;
  gap: 8px;
  padding: 12px;
`

const sendBtn = css`
  align-self: flex-end;
  padding: 8px 16px;
  border-radius: 8px;
  border: none;
  background: var(--primary);
  color: #fff;
  cursor: pointer;
  font-size: 14px;
  flex-shrink: 0;
  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
`

const appendBtn = css`
  align-self: flex-end;
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font-size: 14px;
  flex-shrink: 0;
  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    border-color: transparent;
  }
`

const stopBtn = css`
  align-self: flex-end;
  padding: 8px 16px;
  border-radius: 8px;
  border: none;
  background: var(--error);
  color: #fff;
  cursor: pointer;
  font-size: 14px;
  flex-shrink: 0;
`

const dragOverlay = css`
  position: absolute;
  inset: 0;
  background: rgba(74, 158, 255, 0.12);
  border: 2px dashed var(--accent, #4a9eff);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent, #4a9eff);
  font-size: 14px;
  pointer-events: none;
  z-index: 20;
`

type SendPayload = {
  text: string
  files: string[]
  images: ImagePart[]
  agents: string[]
}

type ComposerProps = {
  onSend: (payload: SendPayload) => void
  onAbort?: () => void
  /** 流式态「追加指令」注入 steering 文本。 */
  onSteer?: (message: string) => void
  isStreaming: boolean
  hasHistory: boolean
  supportsVision?: boolean
  permission?: { tool: string; input: unknown } | null
  onPermissionConfirm?: () => void
  onPermissionCancel?: () => void
  /** 当前项目 id（用于 @ 文件提及按项目 worktree 搜索）。 */
  projectId?: string
  /** 可用 agent 列表（@ mention 渲染与校验）。 */
  agents: AgentListItem[]
}

function Composer(props: ComposerProps) {
  // 从文本提取 @agent mentions，仅保留非 primary（可调用的 subagent/all）
  const handleSend = (payload: { text: string; files: string[]; images: ImagePart[] }) => {
    const subagentNames = props.agents.filter((a) => a.mode !== 'primary').map((a) => a.name)
    const mentions = payload.text.match(/@([\w-]+)/g) ?? []
    const agents = mentions.map((m) => m.slice(1)).filter((name) => subagentNames.includes(name))
    props.onSend({ ...payload, agents })
  }
  const composer = useComposer({
    onSend: handleSend,
    onAbort: props.onAbort,
    onSteer: props.onSteer,
    isStreaming: props.isStreaming,
    hasHistory: props.hasHistory,
  })
  const { data: commands = [] } = useCommands()
  const fileSearch = useFileSearch(composer.popoverQuery, props.projectId)

  // 注册文件引用 API，供文件树/预览面板跨组件调用
  const setFileReferenceApi = useFileReferenceSetter()
  useEffect(() => {
    setFileReferenceApi({
      insertFileReference: composer.appendFileReference,
      insertTextReference: composer.appendTextReference,
    })
    return () => setFileReferenceApi(null)
  }, [composer.appendFileReference, composer.appendTextReference, setFileReferenceApi])

  const [slashActive, setSlashActive] = useState(0)
  const [atActive, setAtActive] = useState(0)
  const [isDragging, setIsDragging] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: query 变化时重置选中项到顶部
  useEffect(() => {
    if (composer.popover === 'slash') setSlashActive(0)
  }, [composer.popover, composer.popoverQuery])
  // biome-ignore lint/correctness/useExhaustiveDependencies: query 变化时重置选中项到顶部
  useEffect(() => {
    if (composer.popover === 'at') setAtActive(0)
  }, [composer.popover, composer.popoverQuery])

  // @ mention 候选：subagent（非 primary）按 query 过滤
  const atSubagents = props.agents
    .filter((a) => a.mode !== 'primary')
    .filter((a) => !composer.popoverQuery || a.name.includes(composer.popoverQuery))
    .slice(0, 5)
  const atFiles = (fileSearch.data ?? []).filter((r) => r.type === 'file')

  // 选中 @agent：替换 @query token 为 @name 文本
  const insertAgentToken = (name: string) => {
    const text = promptToText(composer.promptRef.current)
    const atIdx = text.lastIndexOf('@')
    if (atIdx === -1) return
    const before = text.slice(0, atIdx)
    let tokenEnd = atIdx + 1
    while (tokenEnd < text.length && !/\s/.test(text[tokenEnd] ?? '')) tokenEnd += 1
    const after = text.slice(tokenEnd)
    const newText = `${before}@${name} ${after}`
    const newPrompt: Prompt = [{ type: 'text', content: newText, start: 0, end: newText.length }]
    composer.setPromptExternal(newPrompt)
    composer.setPopover(null)
    composer.editorRef.current?.focus()
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (composer.popover === 'slash') {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashActive((i) => Math.min(i + 1, commands.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashActive((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const cmd = commands[slashActive]
        if (cmd) composer.insertSlash(cmd.name)
        return
      }
    }
    if (composer.popover === 'at') {
      const total = atSubagents.length + atFiles.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtActive((i) => Math.min(i + 1, total - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtActive((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        if (atActive < atSubagents.length) {
          const a = atSubagents[atActive]
          if (a) insertAgentToken(a.name)
        } else {
          const f = atFiles[atActive - atSubagents.length]
          if (f) composer.insertFile(f.path)
        }
        return
      }
    }
    composer.handleKeyDown(e)
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const dropped = Array.from(e.dataTransfer.files)
    const hasImage = dropped.some((f) => f.type.startsWith('image/'))
    for (const f of dropped) {
      if (f.type.startsWith('image/')) composer.addImage(f)
    }
    if (!hasImage) {
      const text = e.dataTransfer.getData('text/plain')
      if (text) document.execCommand('insertText', false, text)
    }
  }

  const sendLabel = props.isStreaming ? '终止' : '发送'

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: composer 拖放区，容器需捕获 drag/drop 事件
    <div
      className={wrap}
      onDragOver={(e) => {
        e.preventDefault()
        if (!isDragging) setIsDragging(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        setIsDragging(false)
      }}
      onDrop={handleDrop}
    >
      {isDragging && <div className={dragOverlay}>拖放图片或文本到此处</div>}
      {props.permission && props.onPermissionConfirm && props.onPermissionCancel && (
        <PermissionDock
          tool={props.permission.tool}
          input={props.permission.input}
          onConfirm={props.onPermissionConfirm}
          onCancel={props.onPermissionCancel}
        />
      )}
      <AttachmentBar
        images={composer.images}
        supportsVision={!!props.supportsVision}
        onRemove={composer.removeImage}
      />
      <div className={editorRow}>
        {composer.popover === 'slash' && (
          <SlashPopover
            query={composer.popoverQuery}
            commands={commands}
            activeIndex={slashActive}
            onSelect={(name) => composer.insertSlash(name)}
          />
        )}
        {composer.popover === 'at' && (
          <AtFilePopover
            results={fileSearch.data ?? []}
            activeIndex={atActive}
            onSelect={(path) => composer.insertFile(path)}
            agents={props.agents}
            query={composer.popoverQuery}
            activeAgentIndex={atActive}
            onAgentSelect={insertAgentToken}
          />
        )}
        <ComposerEditor
          editorRef={composer.editorRef}
          composingRef={composer.composingRef}
          streaming={props.isStreaming}
          hasHistory={props.hasHistory}
          isEmpty={composer.isEmpty}
          onInput={composer.handleInput}
          onKeyDown={handleKeyDown}
          onPaste={composer.handlePaste}
        />
        <button
          className={appendBtn}
          onClick={composer.steer}
          type="button"
          disabled={!props.isStreaming}
          data-testid="append"
        >
          追加指令
        </button>
        <button
          className={props.isStreaming ? stopBtn : sendBtn}
          onClick={composer.send}
          type="button"
          data-testid="send"
        >
          {sendLabel}
        </button>
      </div>
    </div>
  )
}

export type { SendPayload }
export { Composer }
