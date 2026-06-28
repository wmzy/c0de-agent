import { css } from '@linaria/core'
import { useEffect, useRef, useState } from 'react'
import { filesystemAPI } from '../services/filesystem.js'

const container = css`
  position: relative;
  width: 100%;
`

const input = css`
  width: 100%;
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

const dropdown = css`
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  max-height: 240px;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: var(--shadow);
  z-index: 10;
`

const suggestion = css`
  display: block;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  &:hover {
    background: var(--bg-secondary);
  }
`

const suggestionActive = css`
  background: var(--bg-secondary);
`

const loadingHint = css`
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-secondary);
`

const emptyHint = css`
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-secondary);
`

type Suggestion = {
  name: string
  path: string
}

type PathPickerProps = {
  value: string
  onChange: (value: string) => void
  onKeyDown?: (e: React.KeyboardEvent) => void
  placeholder?: string
  testId?: string
  autoFocus?: boolean
}

/**
 * 路径输入框 + 目录自动补全。
 *
 * 输入时自动解析当前所在目录并请求其子目录列表，
 * 按已输入的部分前缀过滤后展示为下拉建议。
 */
export function PathPicker({
  value,
  onChange,
  onKeyDown,
  placeholder,
  testId,
  autoFocus,
}: PathPickerProps) {
  const [open, setOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  // 输入变化时防抖请求目录列表
  useEffect(() => {
    if (!value) {
      setSuggestions([])
      setOpen(false)
      return
    }
    // 解析父目录 + 过滤前缀
    const lastSlash = value.lastIndexOf('/')
    const parentDir = value.slice(0, lastSlash) || '/'
    const filter = value.slice(lastSlash + 1)

    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const result = await filesystemAPI.browse(parentDir)
        const filtered = filter
          ? result.directories.filter((d) => d.name.toLowerCase().startsWith(filter.toLowerCase()))
          : result.directories
        setSuggestions(filtered)
        setOpen(true)
        setActiveIndex(-1)
      } catch {
        setSuggestions([])
        setOpen(false)
      } finally {
        setLoading(false)
      }
    }, 200)

    return () => clearTimeout(timer)
  }, [value])

  // 点击外部关闭下拉
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const selectSuggestion = (s: Suggestion) => {
    onChange(`${s.path}/`)
    inputRef.current?.focus()
    setOpen(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (open && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((prev) => (prev + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1))
        return
      }
      if (e.key === 'Enter' && activeIndex >= 0) {
        const selected = suggestions[activeIndex]
        if (selected) {
          e.preventDefault()
          selectSuggestion(selected)
          return
        }
      }
      if (e.key === 'Escape') {
        setOpen(false)
        return
      }
    }
    onKeyDown?.(e)
  }

  return (
    <div className={container} ref={containerRef}>
      <input
        ref={inputRef}
        className={input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? '/path/to/dir'}
        data-testid={testId ?? 'path-picker-input'}
      />
      {open && (
        <div className={dropdown} role="listbox" data-testid="path-picker-suggestions">
          {loading ? (
            <div className={loadingHint}>加载中…</div>
          ) : suggestions.length === 0 ? (
            <div className={emptyHint}>无匹配目录</div>
          ) : (
            suggestions.map((s, i) => (
              <button
                key={s.path}
                type="button"
                className={i === activeIndex ? `${suggestion} ${suggestionActive}` : suggestion}
                onClick={() => selectSuggestion(s)}
                data-testid={`suggestion-${i}`}
              >
                {s.name}/
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export type { PathPickerProps }
