import { css } from '@linaria/core'
import type { DragEvent, KeyboardEvent } from 'react'
import { useEffect, useState } from 'react'
import { useCommands } from '../hooks/useCommands.js'
import { useFileSearch } from '../hooks/useFiles.js'
import { AtFilePopover } from './AtFilePopover.js'
import { AttachmentBar } from './AttachmentBar.js'
import { ComposerEditor } from './ComposerEditor.js'
import { PermissionDock } from './PermissionDock.js'
import { SlashPopover } from './SlashPopover.js'
import type { ImagePart } from './types.js'
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
  background: var(--accent, #4a9eff);
  color: #fff;
  cursor: pointer;
  font-size: 14px;
  flex-shrink: 0;
  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
`

const stopBtn = css`
  align-self: flex-end;
  padding: 8px 16px;
  border-radius: 8px;
  border: none;
  background: var(--danger, #e5484d);
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
}

type ComposerProps = {
  onSend: (payload: SendPayload) => void
  onAbort?: () => void
  isStreaming: boolean
  steerMode?: boolean
  hasHistory: boolean
  supportsVision?: boolean
  permission?: { tool: string; input: unknown } | null
  onPermissionConfirm?: () => void
  onPermissionCancel?: () => void
}

function Composer(props: ComposerProps) {
  const composer = useComposer({
    onSend: props.onSend,
    onAbort: props.onAbort,
    isStreaming: props.isStreaming,
    steerMode: props.steerMode,
    hasHistory: props.hasHistory,
  })
  const { data: commands = [] } = useCommands()
  const fileSearch = useFileSearch(composer.popoverQuery)

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
      const files = (fileSearch.data ?? []).filter((r) => r.type === 'file')
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtActive((i) => Math.min(i + 1, files.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtActive((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const f = files[atActive]
        if (f) composer.insertFile(f.path)
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

  const isStop = props.isStreaming && !props.steerMode
  const sendLabel = isStop ? '停止' : props.steerMode ? '注入' : '发送'

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
          />
        )}
        <ComposerEditor
          editorRef={composer.editorRef}
          composingRef={composer.composingRef}
          steerMode={props.steerMode}
          hasHistory={props.hasHistory}
          isEmpty={composer.isEmpty}
          onInput={composer.handleInput}
          onKeyDown={handleKeyDown}
          onPaste={composer.handlePaste}
        />
        <button
          className={isStop ? stopBtn : sendBtn}
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
