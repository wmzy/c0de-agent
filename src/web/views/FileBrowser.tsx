import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { fileAPI } from '../services/file.js'
import type { FileEntry, FileSearchResult } from '../types/index.js'

const panel = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`

const row = css`
  padding: 4px 8px;
  cursor: pointer;
  &:hover {
    background: var(--bg-secondary);
  }
`

export function FileBrowser({ onPick }: { onPick: (path: string) => void }) {
  const [path, setPath] = useState('.')
  const [query, setQuery] = useState('')
  const listQ = useQuery({
    queryKey: ['files', path],
    queryFn: () => fileAPI.list(path),
  })
  const searchQ = useQuery({
    queryKey: ['files', 'search', query],
    queryFn: () => fileAPI.search(query),
    enabled: query.length > 1,
  })

  const isSearch = query.length > 1
  const searchEntries: FileSearchResult[] = isSearch ? (searchQ.data ?? []) : []
  const listEntries: FileEntry[] = isSearch ? [] : (listQ.data ?? [])

  return (
    <div className={panel}>
      <input
        placeholder="搜索文件…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ margin: 8, padding: '6px 8px' }}
        data-testid="file-search"
      />
      <div style={{ padding: 4 }}>
        {isSearch ? null : (
          <button
            className={row}
            onClick={() => setPath(path.split('/').slice(0, -1).join('/') || '.')}
            type="button"
          >
            📁 ..
          </button>
        )}
        {searchEntries.map((e) => (
          <button
            key={e.path}
            className={row}
            data-testid={`file-${e.path}`}
            onClick={() => onPick(e.path)}
            type="button"
          >
            {e.type === 'directory' ? '📁' : '📄'} {e.path}
          </button>
        ))}
        {listEntries.map((e) => {
          const fullPath = `${path === '.' ? '' : `${path}/`}${e.name}`
          return (
            <button
              key={fullPath}
              className={row}
              data-testid={`file-${fullPath}`}
              onClick={() => {
                if (e.type === 'directory') setPath(fullPath)
                else onPick(fullPath)
              }}
              type="button"
            >
              {e.type === 'directory' ? '📁' : '📄'} {e.name}
            </button>
          )
        })}
      </div>
    </div>
  )
}
