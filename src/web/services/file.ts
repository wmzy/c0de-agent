import type {
  CommitResponse,
  FileContent,
  FileEntry,
  FileSearchResult,
  GitStatusMap,
} from '../types/index.js'
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
  gitCommit: (
    projectId?: string,
    body?: { mode?: string; message?: string; suggestions?: string[] },
  ) =>
    apiRequest<CommitResponse>(
      `/api/files/git-commit${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      { method: 'POST', body: body ? JSON.stringify(body) : undefined },
    ),
  gitBranch: (projectId?: string) =>
    apiRequest<{ branch: string | null }>(
      `/api/files/git-branch${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  gitLastCommit: (projectId?: string) =>
    apiRequest<{
      commit: { subject: string; hash: string; author: string; date: string } | null
    }>(
      `/api/files/git-last-commit${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  gitBranches: (projectId?: string) =>
    apiRequest<{ branches: { name: string; current: boolean; lastSubject: string | null }[] }>(
      `/api/files/git-branches${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  gitCheckout: (projectId: string, branch: string) =>
    apiRequest<{ branch: string }>(
      `/api/files/git-checkout?projectId=${encodeURIComponent(projectId)}`,
      { method: 'POST', body: JSON.stringify({ branch }) },
    ),
  gitBranchCreate: (projectId: string, name: string) =>
    apiRequest<{ branch: string }>(
      `/api/files/git-branch-create?projectId=${encodeURIComponent(projectId)}`,
      { method: 'POST', body: JSON.stringify({ name }) },
    ),
}

export { fileAPI }
