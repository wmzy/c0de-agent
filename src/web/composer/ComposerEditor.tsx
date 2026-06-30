import { css } from '@linaria/core'
import type { ClipboardEvent, KeyboardEvent, RefObject } from 'react'
import { promptPlaceholder } from './placeholder.js'

const editorWrap = css`
  position: relative;
  flex: 1;
  min-width: 0;
`

const editor = css`
  min-height: 44px;
  max-height: 200px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text);
  font: inherit;
  overflow-y: auto;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
`

const placeholderStyle = css`
  position: absolute;
  top: 10px;
  left: 12px;
  color: var(--text-secondary);
  pointer-events: none;
  user-select: none;
  line-height: 1.5;
`

type Props = {
  editorRef: RefObject<HTMLDivElement | null>
  composingRef: RefObject<boolean>
  steerMode?: boolean
  hasHistory: boolean
  isEmpty: boolean
  onInput: () => void
  onKeyDown: (e: KeyboardEvent) => void
  onPaste: (e: ClipboardEvent) => void
}

function ComposerEditor(props: Props) {
  const placeholder = promptPlaceholder({
    steerMode: !!props.steerMode,
    hasHistory: props.hasHistory,
  })
  return (
    <div className={editorWrap}>
      {props.isEmpty && <span className={placeholderStyle}>{placeholder}</span>}
      {/* biome-ignore lint/a11y/useSemanticElements: contenteditable 富文本编辑器无语义元素等价物 */}
      <div
        ref={props.editorRef}
        className={editor}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        tabIndex={0}
        data-testid="composer-editor"
        onInput={props.onInput}
        onKeyDown={props.onKeyDown}
        onPaste={props.onPaste}
        onCompositionStart={() => {
          props.composingRef.current = true
        }}
        onCompositionEnd={() => {
          props.composingRef.current = false
          props.onInput()
        }}
      />
    </div>
  )
}

export { ComposerEditor }
