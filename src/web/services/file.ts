import type { FileContent, FileEntry, FileSearchResult, GitStatusMap } from '../types/index.js'
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
  delete: (path: string, projectId?: string) =>
    apiRequest<{ path: string; trashed: boolean }>(
      `/api/files/${encodeURI(path)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      { method: 'DELETE' },
    ),
  gitStatus: (projectId?: string) =>
    apiRequest<GitStatusMap>(
      `/api/files/git-status${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  gitCommit: (projectId?: string) =>
    apiRequest<{ committed: boolean; message: string; hash: string; fileCount: number }>(
      `/api/files/git-commit${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      { method: 'POST' },
    ),
  gitBranch: (projectId?: string) =>
    apiRequest<{ branch: string | null }>(
      `/api/files/git-branch${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
}

export { fileAPI }
