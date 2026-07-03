import { defaultKeymap } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { EditorState } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, keymap } from '@codemirror/view'
import { useEffect, useRef, useState } from 'react'
import { useTheme } from '../contexts/ThemeContext.js'
import { fileAPI } from '../services/file.js'

export function CodeEditor({
  path,
  initial,
  projectId,
  gotoLine,
}: {
  path: string
  initial: string
  projectId?: string
  /** 需要滚动定位到的行号（1-indexed）；变化时滚动。null 表示不定位。 */
  gotoLine?: number | null
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
          lang as never,
          ...(resolved === 'dark' ? [oneDark] : []),
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

  // gotoLine 变化时滚动定位到该行（1-indexed）。
  // 滚动 hostRef（实际溢出容器）而非 CodeMirror 的 cm-scroller——
  // 本组件布局下 hostRef 才是 overflow:auto 的滚动容器，cm-scroller 撑满全高不滚动。
  useEffect(() => {
    if (gotoLine == null) return
    const host = hostRef.current
    if (!host) return
    const lines = host.querySelectorAll('.cm-line')
    const line = lines[gotoLine - 1] as HTMLElement | undefined
    if (!line) return
    // 居中该行：按视口坐标计算增量，避免 offsetParent 嵌套问题
    const hostRect = host.getBoundingClientRect()
    const lineRect = line.getBoundingClientRect()
    host.scrollTop += lineRect.top - hostRect.top - hostRect.height / 2 + lineRect.height / 2
  }, [gotoLine])

  const save = async () => {
    const doc = viewRef.current?.state.doc.toString() ?? ''
    await fileAPI.write(path, doc, projectId)
    setDirty(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          padding: 4,
        }}
      >
        <span style={{ fontSize: 12 }}>{path}</span>
        <button onClick={() => void save()} disabled={!dirty} type="button" data-testid="save">
          {dirty ? '保存*' : '已保存'}
        </button>
      </div>
      <div ref={hostRef} style={{ flex: 1, overflow: 'auto' }} />
    </div>
  )
}
