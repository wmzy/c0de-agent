import { css } from '@linaria/core'
import { defaultKeymap } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers } from '@codemirror/view'
import { useEffect, useRef, useState } from 'react'
import type { LineRange } from '../contexts/FileSelectionContext.js'
import { useTheme } from '../contexts/ThemeContext.js'
import { fileAPI } from '../services/file.js'

/** 设置当前高亮行范围的副作用；null 清除高亮。 */
const setHighlightRange = StateEffect.define<LineRange | null>()

/** 行高亮装饰：为范围内每一行加上 cm-highlight-line 类。 */
const highlightLineDeco = Decoration.line({ class: 'cm-highlight-line' })

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    decos = decos.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(setHighlightRange)) continue
      const range = e.value
      if (!range) {
        decos = Decoration.none
        continue
      }
      const doc = tr.state.doc
      const start = Math.max(1, Math.min(range.start, doc.lines))
      const end = Math.max(start, Math.min(range.end, doc.lines))
      const arr = []
      for (let i = start; i <= end; i++) {
        arr.push(highlightLineDeco.range(doc.line(i).from))
      }
      decos = Decoration.set(arr, true)
    }
    return decos
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** GitHub 风格高亮主题：半透明暖黄背景 + 左侧主色描边。用 baseTheme 注入，
 *  避开 wyw-in-js 的 :global 处理问题。 */
const highlightTheme = EditorView.baseTheme({
  '.cm-highlight-line': {
    backgroundColor: 'rgba(255, 213, 79, 0.22)',
    boxShadow: 'inset 3px 0 0 var(--primary, #0969da)',
  },
})

const editorWrap = css`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
`

const editorBar = css`
  display: flex;
  justify-content: space-between;
  padding: 4px;
`

const editorPath = css`
  font-size: 12px;
`

const editorHost = css`
  flex: 1;
  overflow: auto;
`

export function CodeEditor({
  path,
  initial,
  projectId,
  highlightRange,
}: {
  path: string
  initial: string
  projectId?: string
  /** 需要滚动定位并高亮的行范围（1-indexed）；变化时滚动+高亮。null 表示清除高亮。 */
  highlightRange?: LineRange | null
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [dirty, setDirty] = useState(false)
  const { resolved } = useTheme()

  useEffect(() => {
    if (!hostRef.current) return
    const ext = path.split('.').pop()
    const lang = ext === 'ts' || ext === 'js' || ext === 'tsx' || ext === 'jsx' ? javascript() : []
    const view = new EditorView({
      state: EditorState.create({
        doc: initial,
        extensions: [
          keymap.of(defaultKeymap),
          lineNumbers(),
          lang as never,
          ...(resolved === 'dark' ? [oneDark] : []),
          highlightField,
          highlightTheme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(true)
          }),
        ],
      }),
      parent: hostRef.current,
    })
    viewRef.current = view
    return () => view.destroy()
  }, [path, initial, resolved])

  // highlightRange 变化时：dispatch 高亮副作用 + 滚动起始行至视口中央。
  // 滚动 hostRef（实际溢出容器）而非 CodeMirror 的 cm-scroller——
  // 本组件布局下 hostRef 才是 overflow:auto 的滚动容器，cm-scroller 撑满全高不滚动。
  useEffect(() => {
    const view = viewRef.current
    if (view) {
      view.dispatch({ effects: setHighlightRange.of(highlightRange ?? null) })
    }
    if (!highlightRange) return
    const host = hostRef.current
    if (!host) return
    const lines = host.querySelectorAll('.cm-line')
    const line = lines[highlightRange.start - 1] as HTMLElement | undefined
    if (!line) return
    const hostRect = host.getBoundingClientRect()
    const lineRect = line.getBoundingClientRect()
    host.scrollTop += lineRect.top - hostRect.top - hostRect.height / 2 + lineRect.height / 2
  }, [highlightRange])

  const save = async () => {
    const doc = viewRef.current?.state.doc.toString() ?? ''
    await fileAPI.write(path, doc, projectId)
    setDirty(false)
  }

  return (
    <div className={editorWrap}>
      <div className={editorBar}>
        <span className={editorPath}>{path}</span>
        <button onClick={() => void save()} disabled={!dirty} type="button" data-testid="save">
          {dirty ? '保存*' : '已保存'}
        </button>
      </div>
      <div ref={hostRef} className={editorHost} />
    </div>
  )
}
