import { defaultKeymap } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers } from '@codemirror/view'
import { css } from '@linaria/core'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from 'haze-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LineRange } from '@/contexts/FileSelectionContext.js'
import { useTheme } from '@/contexts/ThemeContext.js'
import { fileAPI } from '@/services/file.js'

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
    boxShadow: 'inset 3px 0 0 var(--haze-color-primary, #0969da)',
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

/** 外部变更/保存冲突横幅：黄系警示，动作按钮行内排布。 */
const conflictBanner = css`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--haze-color-warning, #9a6700);
  background: color-mix(in oklab, var(--haze-color-warning, #9a6700) 12%, transparent);
  border-bottom: 1px solid color-mix(in oklab, var(--haze-color-warning, #9a6700) 30%, transparent);
`

const conflictActions = css`
  display: flex;
  gap: 6px;
  margin-left: auto;
`

export function CodeEditor({
  path,
  initial,
  projectId,
  highlightRange,
  onDirtyChange,
}: {
  path: string
  initial: string
  projectId?: string
  /** 需要滚动定位并高亮的行范围（1-indexed）；变化时滚动+高亮。null 表示清除高亮。 */
  highlightRange?: LineRange | null
  /** 脏状态回调：文档被编辑或重置（切换文件/保存）时通知父组件，用于关闭前确认等守卫。 */
  onDirtyChange?: (dirty: boolean) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [dirty, setDirty] = useState(false)
  const { resolved } = useTheme()
  const qc = useQueryClient()

  // P1 人机文件协作——编辑器与磁盘内容的三方基础：
  // baseRef = 编辑器内容最后一次与磁盘同步的快照（打开时 / 外部重载后 / 保存成功后）。
  // 保存前比对「磁盘当前内容 vs baseRef」即可判断是否有外部修改（agent/其他窗口）。
  const baseRef = useRef(initial)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  // 最新 initial 的已见标记：仅当父组件喂入新内容时才评估「应用 or 挂起」。
  const lastInitialRef = useRef(initial)
  /** 编辑器有未保存修改时到达的外部内容——挂起待用户决断，绝不静默重建覆盖。 */
  const [pendingExternal, setPendingExternal] = useState<string | null>(null)
  /** 保存冲突详情（磁盘内容 ≠ baseRef 时阻止盲写）。 */
  const [saveConflict, setSaveConflict] = useState<{ disk: string } | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)

  // ref 持有最新回调，避免回调身份变化触发重复通知
  const onDirtyChangeRef = useRef(onDirtyChange)
  onDirtyChangeRef.current = onDirtyChange
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty)
  }, [dirty])

  /** 用指定内容整体替换编辑器文档（外部重载/改用磁盘版本），并重置同步基线。 */
  const applyContent = useCallback((content: string) => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
    baseRef.current = content
    setDirty(false)
    setPendingExternal(null)
    setSaveConflict(null)
  }, [])

  // 记录上次路径：仅换文件时重置基线；主题切换重建沿用当前基线（不吞挂起的外部内容）。
  const prevPathRef = useRef(path)
  useEffect(() => {
    if (!hostRef.current) return
    if (prevPathRef.current !== path) {
      prevPathRef.current = path
      baseRef.current = lastInitialRef.current
      setPendingExternal(null)
      setSaveConflict(null)
    }
    const ext = path.split('.').pop()
    const lang = ext === 'ts' || ext === 'js' || ext === 'tsx' || ext === 'jsx' ? javascript() : []
    const view = new EditorView({
      state: EditorState.create({
        doc: baseRef.current,
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
    // 重建视图 = 换文件/重读内容，脏状态随之重置（避免上个文件的脏标记误伤新文件）
    setDirty(false)
    return () => view.destroy()
  }, [path, resolved])

  // 父组件喂入新服务端内容（React Query 失效刷新/换文件）：
  // - 干净状态 → 直接应用（编辑器跟随磁盘，原行为）；
  // - 脏状态 → 挂起 + 横幅提示。此前无条件重建视图会把用户未保存的修改静默清掉。
  useEffect(() => {
    if (lastInitialRef.current === initial) return
    lastInitialRef.current = initial
    if (initial === baseRef.current) {
      setPendingExternal(null)
      return
    }
    if (dirtyRef.current) setPendingExternal(initial)
    else applyContent(initial)
  }, [initial, applyContent])

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

  /** 保存：force=true 跳过冲突检查（用户在冲突框中选择「覆盖保存」）。 */
  const save = async (force = false) => {
    const doc = viewRef.current?.state.doc.toString() ?? ''
    if (!force) {
      // 冲突检测：磁盘当前内容 vs 打开时的基线。不一致 → 阻断盲写，交用户决断。
      // 读取失败（文件已被移入回收站等）不阻断——写入会重建文件。
      try {
        const disk = await fileAPI.read(path, projectId)
        if (disk.content !== baseRef.current) {
          setSaveConflict({ disk: disk.content })
          return
        }
      } catch {
        // 磁盘读取失败：维持原行为直接写入
      }
    }
    try {
      await fileAPI.write(path, doc, projectId)
      baseRef.current = doc
      setDirty(false)
      setSaveConflict(null)
      setWriteError(null)
      // 同步查询缓存：避免缓存中的旧内容经 initial 回灌覆盖刚保存的文档
      qc.invalidateQueries({ queryKey: ['file', path, projectId] })
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className={editorWrap}>
      <div className={editorBar}>
        <span className={editorPath}>{path}</span>
        <Button variant="outline" onClick={() => void save()} disabled={!dirty} data-testid="save">
          {dirty ? '保存*' : '已保存'}
        </Button>
      </div>

      {pendingExternal !== null && (
        <div className={conflictBanner} data-testid="external-change-banner">
          <span>
            ⚠ 磁盘上的文件已在你编辑期间被修改（可能是 agent
            或其他窗口）。你的未保存修改仍保留在编辑器中，保存时将进行冲突检查。
          </span>
          <div className={conflictActions}>
            <Button
              variant="outline"
              onClick={() => applyContent(pendingExternal)}
              data-testid="external-discard-local"
            >
              放弃本地修改并重载
            </Button>
            <Button
              variant="outline"
              onClick={() => setPendingExternal(null)}
              data-testid="external-keep-local"
            >
              继续编辑
            </Button>
          </div>
        </div>
      )}

      {saveConflict !== null && (
        <div className={conflictBanner} data-testid="save-conflict-banner">
          <span>
            保存冲突：磁盘内容已在你打开文件后被修改（可能是 agent
            或其他窗口）。覆盖保存将丢失那些修改。
          </span>
          <div className={conflictActions}>
            <Button
              variant="outline"
              onClick={() => void save(true)}
              data-testid="conflict-overwrite"
            >
              覆盖保存
            </Button>
            <Button
              variant="outline"
              onClick={() => applyContent(saveConflict.disk)}
              data-testid="conflict-use-disk"
            >
              放弃本地，改用磁盘版本
            </Button>
            <Button
              variant="outline"
              onClick={() => setSaveConflict(null)}
              data-testid="conflict-cancel"
            >
              取消
            </Button>
          </div>
        </div>
      )}

      {writeError !== null && (
        <div className={conflictBanner} data-testid="write-error-banner">
          保存失败：{writeError}
        </div>
      )}

      <div ref={hostRef} className={editorHost} />
    </div>
  )
}
