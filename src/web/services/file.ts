import type { FileContent, FileEntry, FileSearchResult } from '../types/index.js'
import { apiRequest } from './api.js'

const fileAPI = {
  list: (path: string) => apiRequest<FileEntry[]>(`/api/files?path=${encodeURIComponent(path)}`),
  read: (path: string) => apiRequest<FileContent>(`/api/files/${encodeURI(path)}`),
  write: (path: string, content: string) =>
    apiRequest<{ path: string; written: boolean }>(`/api/files/${encodeURI(path)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
  search: (query: string, projectId?: string) =>
    apiRequest<FileSearchResult[]>(
      `/api/files/search?q=${encodeURIComponent(query)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
}

export { fileAPI }
