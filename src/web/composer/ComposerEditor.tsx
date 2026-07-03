import { css } from '@linaria/core'
import type { ClipboardEvent, KeyboardEvent, MouseEvent, RefObject } from 'react'
import { useRef, useState } from 'react'
import { useFileSelection } from '../contexts/FileSelectionContext.js'
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

/** snippet pill 的 hover 预览浮层：展示选中的代码内容。 */
const snippetTip = css`
  position: fixed;
  z-index: 50;
  transform: translate(-50%, -100%);
  margin-top: -6px;
  max-width: 560px;
  max-height: 320px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  pointer-events: none;
`

type Props = {
  editorRef: RefObject<HTMLDivElement | null>
  composingRef: RefObject<boolean>
  streaming?: boolean
  hasHistory: boolean
  isEmpty: boolean
  onInput: () => void
  onKeyDown: (e: KeyboardEvent) => void
  onPaste: (e: ClipboardEvent) => void
}

function ComposerEditor(props: Props) {
  const placeholder = promptPlaceholder({
    streaming: !!props.streaming,
    hasHistory: props.hasHistory,
  })
  const { openFile } = useFileSelection()
  // hover tooltip：仅当鼠标进入 snippet pill 时展示其 snippet 内容。
  // 用 ref 记录当前 hover 的 pill，避免 mouseover 重复触发 setState。
  const hoverPillRef = useRef<HTMLElement | null>(null)
  const [tip, setTip] = useState<{ snippet: string; x: number; y: number } | null>(null)

  const handleMouseOver = (e: MouseEvent) => {
    const pill = (e.target as HTMLElement).closest('[data-type="snippet"]') as HTMLElement | null
    if (pill && pill !== hoverPillRef.current) {
      hoverPillRef.current = pill
      const rect = pill.getBoundingClientRect()
      setTip({ snippet: pill.dataset.snippet ?? '', x: rect.left + rect.width / 2, y: rect.top })
    } else if (!pill && hoverPillRef.current) {
      hoverPillRef.current = null
      setTip(null)
    }
  }

  const handleMouseOut = (e: MouseEvent) => {
    // relatedTarget 不在任何 snippet pill 内时才隐藏（防止 pill 内部子节点移动误触）
    const related = e.relatedTarget as HTMLElement | null
    if (hoverPillRef.current && !related?.closest?.('[data-type="snippet"]')) {
      hoverPillRef.current = null
      setTip(null)
    }
  }

  // click snippet pill → 右侧打开文件并定位到起始行
  const handleClick = (e: MouseEvent) => {
    const pill = (e.target as HTMLElement).closest('[data-type="snippet"]') as HTMLElement | null
    if (!pill) return
    e.preventDefault()
    const path = pill.dataset.path
    const line = Number(pill.dataset.lineStart ?? '1')
    if (path) openFile(path, line)
  }

  return (
    <div className={editorWrap}>
      {props.isEmpty && <span className={placeholderStyle}>{placeholder}</span>}
      {tip && (
        <div className={snippetTip} style={{ left: tip.x, top: tip.y }}>
          {tip.snippet}
        </div>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: contenteditable 富文本编辑器无语义元素等价物 */}
      {/* biome-ignore lint/a11y/useKeyWithMouseEvents: snippet pill 的 hover tooltip 是纯鼠标增强，键盘焦点不适用 */}
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
        onMouseOver={handleMouseOver}
        onMouseOut={handleMouseOut}
        onClick={handleClick}
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
