import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { fileAPI } from '../services/file.js'
import { useTheme } from '../contexts/ThemeContext.js'

export function CodeEditor({
  path,
  initial,
}: {
  path: string
  initial: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [dirty, setDirty] = useState(false)
  const { resolved } = useTheme()

  useEffect(() => {
    if (!hostRef.current) return
    const ext = path.split('.').pop()
    const lang =
      ext === 'ts' || ext === 'js' || ext === 'tsx' || ext === 'jsx'
        ? javascript()
        : []
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

  const save = async () => {
    const doc = viewRef.current?.state.doc.toString() ?? ''
    await fileAPI.write(path, doc)
    setDirty(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          padding: 4,
        }}
      >
        <span style={{ fontSize: 12 }}>{path}</span>
        <button
          onClick={() => void save()}
          disabled={!dirty}
          type="button"
          data-testid="save"
        >
          {dirty ? '保存*' : '已保存'}
        </button>
      </div>
      <div ref={hostRef} style={{ flex: 1, overflow: 'auto' }} />
    </div>
  )
}
