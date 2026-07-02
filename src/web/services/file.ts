import type { FileContent, FileEntry, FileSearchResult } from '../types/index.js'
import { apiRequest } from './api.js'

const fileAPI = {
  list: (path: string, projectId?: string) =>
    apiRequest<FileEntry[]>(
      `/api/files?path=${encodeURIComponent(path)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  read: (path: string, projectId?: string) =>
    apiRequest<FileContent>(
      `/api/files/${encodeURI(path)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  write: (path: string, content: string, projectId?: string) =>
    apiRequest<{ path: string; written: boolean }>(
      `/api/files/${encodeURI(path)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      {
        method: 'PUT',
        body: JSON.stringify({ content }),
      },
    ),
  search: (query: string, projectId?: string) =>
    apiRequest<FileSearchResult[]>(
      `/api/files/search?q=${encodeURIComponent(query)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
}

export { fileAPI }
