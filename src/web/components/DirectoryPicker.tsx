import { css } from '@linaria/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { filesystemAPI } from '../services/filesystem.js'
import {
  activeTreeNavigation,
  cleanPickerInput,
  createDirectorySearch,
  currentPickerSuggestions,
  displayPickerPath,
  nextSuggestionIndex,
  pickerParent,
  pickerRoot,
} from './directory-picker-domain.js'
import { FileTree, type TreeNode } from './FileTree.js'

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
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  &:focus {
    outline: none;
    border-color: var(--primary);
  }
`

const actions = css`
  display: flex;
  flex-shrink: 0;
  gap: 4px;
`

const actionBtn = css`
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  &:hover {
    border-color: var(--primary);
    color: var(--text);
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
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  box-shadow: var(--shadow);
  max-height: 220px;
  overflow-y: auto;
`

const suggestion = css`
  overflow: hidden;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  &:hover,
  &[data-active] {
    color: var(--text);
    background: var(--bg-secondary);
  }
`

const browser = css`
  position: relative;
  min-height: 0;
  flex: 1;
  max-height: 280px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
`

const state = css`
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--text-secondary);
  font-size: 12px;
  pointer-events: none;
`

const selectionBar = css`
  overflow: hidden;
  flex-shrink: 0;
  color: var(--text-secondary);
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
  autoFocus?: boolean
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
  autoFocus,
}: DirectoryPickerProps) {
  const [home, setHome] = useState('')
  const [root, setRoot] = useState('')
  const [treeRoot, setTreeRoot] = useState<TreeNode | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [navLoading, setNavLoading] = useState(false)
  const [navError, setNavError] = useState(false)
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

  // autoFocus 由 ref 实现（避免 a11y noAutofocus）
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

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

  // navigate：加载目录到文件树
  const navigate = useCallback(
    async (path: string) => {
      const token = ++navigation.current
      setNavLoading(true)
      setNavError(false)
      setSelected(null)
      setSuggestionsOpen(false)
      setActiveSuggestion(-1)
      setRoot(path)
      rootRef.current = path
      setTreeRoot(null)
      setExpanded(new Set())
      const display = displayPickerPath(path, path, homeRef.current)
      onChange(display)
      try {
        const r = await filesystemAPI.browse(path)
        if (!activeTreeNavigation(token, navigation.current)) return
        const children: TreeNode[] = r.directories.map((d) => ({ name: d.name, path: d.path }))
        const baseName = path.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? path
        setTreeRoot({ name: baseName || '/', path, children })
      } catch {
        if (activeTreeNavigation(token, navigation.current)) setNavError(true)
      } finally {
        if (activeTreeNavigation(token, navigation.current)) setNavLoading(false)
      }
    },
    [onChange],
  )

  // 首次自动导航到 start/home
  useEffect(() => {
    const initial = start || home
    if (!initial || root) return
    void navigate(initial)
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
        setLoadingPaths((prev) => new Set(prev).add(path))
        try {
          const r = await filesystemAPI.browse(path)
          const children: TreeNode[] = r.directories.map((d) => ({ name: d.name, path: d.path }))
          setTreeRoot((root) => (root ? setChildren(root, path, children) : root))
        } catch {
          setTreeRoot((root) => (root ? setChildren(root, path, []) : root))
        } finally {
          setLoadingPaths((prev) => {
            const next = new Set(prev)
            next.delete(path)
            return next
          })
        }
      }
    },
    [treeRoot, loadingPaths],
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
      if (suggestionsOpen && currentItems.length > 0) {
        const s = currentItems[activeSuggestion] ?? currentItems[0]
        if (s) {
          e.preventDefault()
          chooseSuggestion(s)
          return
        }
      }
      // 无建议：尝试按输入导航
      e.preventDefault()
      void navigate(cleanPickerInput(value))
      return
    }
    if (e.key === 'Escape') {
      setSuggestionsOpen(false)
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
        <input
          ref={inputRef}
          className={input}
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
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
        {!navLoading && navError ? <div className={state}>读取失败</div> : null}
        {!navLoading && !navError && treeRoot ? (
          <FileTree
            root={treeRoot}
            expanded={expanded}
            selected={selected}
            loadingPaths={loadingPaths}
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
