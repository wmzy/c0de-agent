import { css } from '@linaria/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  activeTreeNavigation,
  cleanPickerInput,
  createDirectorySearch,
  currentPickerSuggestions,
  displayPickerPath,
  nextSuggestionIndex,
  pickerParent,
  pickerRoot,
} from '@/components/directory-picker-domain.js'
import { FileTree, type TreeNode } from '@/components/FileTree.js'
import { SyncedInput } from '@/components/SyncedControls.js'
import { filesystemAPI } from '@/services/filesystem.js'
import { isImeComposing } from '@/utils/ime.js'

const container = css`
  position: relative;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const pathRow = css`
  position: relative;
  display: flex;
  gap: 6px;
`

const input = css`
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  font-size: 13px;
  &:focus {
    outline: none;
    border-color: var(--haze-color-primary);
  }
`

const actions = css`
  display: flex;
  flex-shrink: 0;
  gap: 4px;
`

const actionBtn = css`
  padding: 6px 10px;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  &:hover {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-text);
  }
`

const suggestions = css`
  position: absolute;
  z-index: 20;
  top: 38px;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  box-shadow: var(--haze-shadow-md);
  max-height: 220px;
  overflow-y: auto;
`

const suggestion = css`
  overflow: hidden;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  &:hover,
  &[data-active] {
    color: var(--haze-color-text);
    background: var(--haze-color-bg-subtle);
  }
`

const browser = css`
  position: relative;
  min-height: 0;
  flex: 1;
  max-height: 280px;
  overflow: auto;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: transparent;
`

const state = css`
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  pointer-events: none;
`

/** 根目录读取失败：给出原因 + 重试（「读取失败」四个字既不说明原因也无法自救）。 */
const errorState = css`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  color: var(--haze-color-danger, #e5484d);
  font-size: 12px;
  text-align: center;
`

const retryBtn = css`
  min-height: auto;
  padding: 2px 10px;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  font-size: 12px;
  cursor: pointer;
  &:hover {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-primary);
  }
`

const selectionBar = css`
  overflow: hidden;
  flex-shrink: 0;
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
`

type Suggestion = { absolute: string; type: 'directory' }

type DirectoryPickerProps = {
  value: string
  onChange: (value: string) => void
  onKeyDown?: (e: React.KeyboardEvent) => void
  mode?: 'directory'
  start?: string
  placeholder?: string
  testId?: string
}

/** 目录选择器：输入搜索（递归 + 模糊）+ 文件树浏览 + 快捷导航。
 * 对齐 opencode DialogSelectDirectoryV2。契约与旧 PathPicker 一致（value/onChange）。 */
export function DirectoryPicker({
  value,
  onChange,
  onKeyDown,
  start,
  placeholder,
  testId,
}: DirectoryPickerProps) {
  const [home, setHome] = useState('')
  const [root, setRoot] = useState('')
  const [treeRoot, setTreeRoot] = useState<TreeNode | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [navLoading, setNavLoading] = useState(false)
  /** 根目录读取失败的原因（null=无失败）。此前只有 boolean，渲染成「读取失败」四个字。 */
  const [navError, setNavError] = useState<string | null>(null)
  /** 子目录懒加载失败原因（path → message）。与 FileBrowser 同口径：由树里
   *  的失败态 + 重试承接，绝不落成 children: []（那正是「（空）」分支）。 */
  const [loadErrors, setLoadErrors] = useState<Map<string, string>>(new Map())
  const [suggestionList, setSuggestionList] = useState<
    { query: string; items: Suggestion[] } | undefined
  >()
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(-1)

  const homeRef = useRef('')
  const rootRef = useRef('')
  const navigation = useRef(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const pathAreaRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  homeRef.current = home
  rootRef.current = root

  // 首次加载 home
  useEffect(() => {
    let cancelled = false
    filesystemAPI
      .home()
      .then((r) => {
        if (!cancelled) {
          setHome(r.path)
          homeRef.current = r.path
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // 搜索实例（getter 读最新 home/root，缓存复用）
  const search = useMemo(
    () =>
      createDirectorySearch({
        listDir: async (dir) => {
          const r = await filesystemAPI.browse(dir)
          return r.directories.map((d) => ({ name: d.name, absolute: d.path }))
        },
        searchDir: async (dir, q, limit) => (await filesystemAPI.search(dir, q, limit)).items,
        home: () => homeRef.current,
        base: () => rootRef.current || start || homeRef.current,
      }),
    [start],
  )

  // navigate：加载目录到文件树。
  // silent：仅浏览不回填宿主值——用于首次自动导航到 start/home，此时用户尚未
  // 做任何选择，回填会让宿主（如 AddProjectDialog）拿到一个从未被选中的 `~`，
  // 其「value 非空即可提交」的判断随即成立：直接回车就把 $HOME 注册成项目。
  const navigate = useCallback(
    async (path: string, options?: { silent?: boolean }) => {
      const token = ++navigation.current
      setNavLoading(true)
      setNavError(null)
      setSelected(null)
      setSuggestionsOpen(false)
      setActiveSuggestion(-1)
      setRoot(path)
      rootRef.current = path
      setTreeRoot(null)
      setExpanded(new Set())
      setLoadErrors(new Map())
      if (!options?.silent) onChange(displayPickerPath(path, path, homeRef.current))
      try {
        const r = await filesystemAPI.browse(path)
        if (!activeTreeNavigation(token, navigation.current)) return
        const children: TreeNode[] = r.directories.map((d) => ({ name: d.name, path: d.path }))
        const baseName = path.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? path
        setTreeRoot({ name: baseName || '/', path, children })
      } catch (err) {
        if (activeTreeNavigation(token, navigation.current)) setNavError(pickerErrorMessage(err))
      } finally {
        if (activeTreeNavigation(token, navigation.current)) setNavLoading(false)
      }
    },
    [onChange],
  )

  // 首次自动导航到 start/home：只加载文件树，不回填宿主值（见 navigate 的 silent）
  useEffect(() => {
    const initial = start || home
    if (!initial || root) return
    void navigate(initial, { silent: true })
  }, [start, home, root, navigate])

  // 输入变化 → 防抖搜索
  useEffect(() => {
    const typed = cleanPickerInput(value)
    const current = displayPickerPath(rootRef.current, value, homeRef.current).replace(/\/+$/, '')
    if (!typed || typed === current) {
      setSuggestionList({ query: typed, items: [] })
      setSuggestionsOpen(false)
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      const items = await search(typed)
      if (cancelled) return
      const mapped: Suggestion[] = items
        .slice(0, 5)
        .map((absolute) => ({ absolute, type: 'directory' }))
      setSuggestionList({ query: typed, items: mapped })
      setSuggestionsOpen(true)
      setActiveSuggestion(-1)
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [value, search])

  const currentItems = useMemo(
    () => currentPickerSuggestions(suggestionList, cleanPickerInput(value)),
    [suggestionList, value],
  )

  /** 懒加载某目录的子项：失败落到 loadErrors，由树里的失败态 + 重试承接。 */
  const loadChildren = useCallback(async (dirPath: string) => {
    setLoadingPaths((prev) => new Set(prev).add(dirPath))
    setLoadErrors((prev) => {
      if (!prev.has(dirPath)) return prev
      const next = new Map(prev)
      next.delete(dirPath)
      return next
    })
    try {
      const r = await filesystemAPI.browse(dirPath)
      const children: TreeNode[] = r.directories.map((d) => ({ name: d.name, path: d.path }))
      setTreeRoot((root) => (root ? setChildren(root, dirPath, children) : root))
    } catch (err) {
      // 失败不能落成 children: []——那正是 FileTree 的「（空）」分支，
      // 把「读不到」说成「没有」。记录原因，就地展示并允许重试。
      setLoadErrors((prev) => new Map(prev).set(dirPath, pickerErrorMessage(err)))
    } finally {
      setLoadingPaths((prev) => {
        const next = new Set(prev)
        next.delete(dirPath)
        return next
      })
    }
  }, [])

  const toggle = useCallback(
    async (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      })
      // 首次展开且未加载子目录 → 懒加载
      const node = findNode(treeRoot, path)
      if (node && node.children === undefined && !loadingPaths.has(path)) {
        await loadChildren(path)
      }
    },
    [treeRoot, loadingPaths, loadChildren],
  )

  const select = useCallback(
    (path: string) => {
      setSelected(path)
      onChange(path)
    },
    [onChange],
  )

  const chooseSuggestion = useCallback(
    (s: Suggestion) => {
      if (s.type === 'directory') void navigate(s.absolute)
    },
    [navigate],
  )

  const moveSuggestion = useCallback(
    (delta: -1 | 1) => {
      setSuggestionsOpen(true)
      setActiveSuggestion((cur) => nextSuggestionIndex(cur, delta, currentItems.length))
    },
    [currentItems.length],
  )

  const handleInputKey = (e: React.KeyboardEvent) => {
    // IME 组合中不拦截：回车确认候选词/ESC 取消候选由输入法处理——不判定会把
    // 未确认的候选当最终输入（回车选中建议或按半截输入导航）。
    if (isImeComposing(e)) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveSuggestion(1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveSuggestion(-1)
      return
    }
    if (e.key === 'Enter') {
      // 有可消费的建议 → 选择该建议；否则透传给宿主（onKeyDown 契约的
      // 「未处理键透传」——AddProjectDialog/RelocateProjectDialog 以 Enter 提交表单）。
      // 此前无建议时恒 preventDefault + navigate 并 return：宿主的 Enter 分支是死代码，
      // 输入完整路径后按回车不会提交。
      if (suggestionsOpen && currentItems.length > 0) {
        const s = currentItems[activeSuggestion] ?? currentItems[0]
        if (s) {
          e.preventDefault()
          chooseSuggestion(s)
          return
        }
      }
      onKeyDown?.(e)
      return
    }
    if (e.key === 'Escape') {
      // 建议列表打开 → 只关建议（层级消费，不透传）；未打开 → 透传给宿主
      // （此前无条件 return：宿主写的 Escape 关闭对话框从不执行，用户按 Esc 关不掉弹窗）。
      if (suggestionsOpen) {
        e.preventDefault()
        setSuggestionsOpen(false)
        return
      }
      onKeyDown?.(e)
      return
    }
    onKeyDown?.(e)
  }

  // 点击外部关闭建议
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (pathAreaRef.current?.contains(e.target as Node)) return
      setSuggestionsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  return (
    <div
      className={container}
      ref={containerRef}
      data-testid={testId ? undefined : 'directory-picker'}
    >
      <div className={pathRow} ref={pathAreaRef}>
        <SyncedInput
          ref={inputRef}
          className={input}
          value={value}
          onChange={(v) => {
            onChange(v)
            setSelected(null)
            setSuggestionsOpen(true)
            setActiveSuggestion(-1)
          }}
          onKeyDown={handleInputKey}
          placeholder={placeholder ?? '/path/to/dir'}
          data-testid={testId ?? 'directory-picker-input'}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggestionsOpen}
          aria-controls="directory-picker-suggestions"
        />
        <div className={actions}>
          <button
            type="button"
            className={actionBtn}
            onClick={() => void navigate(home)}
            aria-label="home"
          >
            ~
          </button>
          <button
            type="button"
            className={actionBtn}
            onClick={() => void navigate(pickerRoot(root) || root)}
            aria-label="根目录"
          >
            /
          </button>
          <button
            type="button"
            className={actionBtn}
            onClick={() => void navigate(pickerParent(root))}
            aria-label="父目录"
          >
            ↑
          </button>
        </div>
        {suggestionsOpen && currentItems.length > 0 && (
          <div id="directory-picker-suggestions" role="listbox" className={suggestions}>
            {currentItems.map((s, i) => (
              <button
                key={s.absolute}
                type="button"
                role="option"
                aria-selected={i === activeSuggestion}
                data-active={i === activeSuggestion ? '' : undefined}
                className={suggestion}
                data-testid={`suggestion-${i}`}
                onMouseEnter={() => setActiveSuggestion(i)}
                onClick={() => chooseSuggestion(s)}
              >
                {displayPickerPath(s.absolute, value, home)}
                {s.type === 'directory' ? '/' : ''}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className={browser}>
        {navLoading ? <div className={state}>加载中…</div> : null}
        {!navLoading && navError ? (
          <div className={errorState} data-testid="directory-picker-error">
            <span>{navError}</span>
            <button
              type="button"
              className={retryBtn}
              data-testid="directory-picker-retry"
              onClick={() => void navigate(root)}
            >
              重试
            </button>
          </div>
        ) : null}
        {!navLoading && !navError && treeRoot ? (
          <FileTree
            root={treeRoot}
            expanded={expanded}
            selected={selected}
            loadingPaths={loadingPaths}
            errorPaths={loadErrors}
            onRetryLoad={(p) => void loadChildren(p)}
            onToggle={toggle}
            onSelect={select}
          />
        ) : null}
      </div>
      <div className={selectionBar} data-testid="directory-picker-selection">
        {selected ?? (root ? displayPickerPath(root, value, home) : '')}
      </div>
    </div>
  )
}

/** 读取失败的用户可见原因：APIError 是结构体而非 Error 子类，必须结构化取
 *  message（同 FileBrowser rootError 口径），否则展示的是 "[object Object]"。 */
function pickerErrorMessage(err: unknown): string {
  const message = (err as { message?: string } | null)?.message
  if (typeof message === 'string' && message.length > 0) return message
  if (err instanceof Error && err.message.length > 0) return err.message
  return '无法读取该目录'
}

/** 在树中按 path 查找节点。 */
function findNode(node: TreeNode | null, path: string): TreeNode | null {
  if (!node) return null
  if (node.path === path) return node
  if (node.children) {
    for (const c of node.children) {
      const found = findNode(c, path)
      if (found) return found
    }
  }
  return null
}

/** 不可变更新：设置 path 节点的 children。 */
function setChildren(node: TreeNode, path: string, children: TreeNode[]): TreeNode {
  if (node.path === path) return { ...node, children }
  if (node.children)
    return { ...node, children: node.children.map((c) => setChildren(c, path, children)) }
  return node
}

export type { DirectoryPickerProps }
