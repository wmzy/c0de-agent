import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { css } from '@linaria/core'
import { fileAPI } from '../services/file.js'

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

export function FileBrowser({
  onPick,
}: {
  onPick: (path: string) => void
}) {
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

  const entries = query ? (searchQ.data ?? []) : (listQ.data ?? [])
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
        {query ? null : (
          <button
            className={row}
            onClick={() =>
              setPath(path.split('/').slice(0, -1).join('/') || '.')
            }
            type="button"
          >
            📁 ..
          </button>
        )}
        {entries.map((e) => {
          const fullPath = query
            ? e.path
            : `${path === '.' ? '' : path + '/'}${e.name ?? e.path}`
          return (
            <button
              key={fullPath}
              className={row}
              data-testid={`file-${fullPath}`}
              onClick={() => {
                if (e.type === 'directory' && !query) setPath(fullPath)
                else onPick(fullPath)
              }}
              type="button"
            >
              {e.type === 'directory' ? '📁' : '📄'}{' '}
              {query ? e.path : e.name}
            </button>
          )
        })}
      </div>
    </div>
  )
}
