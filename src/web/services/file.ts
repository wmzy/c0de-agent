import { del, get, post, put } from '@/services/api.js'

import type {
  CommitResponse,
  FileContent,
  FileEntry,
  FileSearchResult,
  GitStatusMap,
} from '@/types/index.js'

const fileAPI = {
  list: (path: string, projectId?: string) =>
    get<FileEntry[]>(
      `/api/files?path=${encodeURIComponent(path)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  read: (path: string, projectId?: string) =>
    get<FileContent>(
      `/api/files/${encodeURI(path)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  write: (path: string, content: string, projectId?: string) =>
    put<{ path: string; written: boolean }>(
      `/api/files/${encodeURI(path)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      { content },
    ),
  search: (query: string, projectId?: string) =>
    get<FileSearchResult[]>(
      `/api/files/search?q=${encodeURIComponent(query)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  delete: (path: string, projectId?: string) =>
    del<{ path: string; trashed: boolean }>(
      `/api/files/${encodeURI(path)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  gitStatus: (projectId?: string) =>
    get<GitStatusMap>(
      `/api/files/git-status${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  gitCommit: (
    projectId?: string,
    body?: { mode?: string; message?: string; suggestions?: string[] },
  ) =>
    post<CommitResponse>(
      `/api/files/git-commit${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      body || undefined,
    ),
  gitBranch: (projectId?: string) =>
    get<{ branch: string | null }>(
      `/api/files/git-branch${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  gitLastCommit: (projectId?: string) =>
    get<{
      commit: { subject: string; hash: string; author: string; date: string } | null
    }>(
      `/api/files/git-last-commit${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  gitBranches: (projectId?: string) =>
    get<{ branches: { name: string; current: boolean; lastSubject: string | null }[] }>(
      `/api/files/git-branches${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  gitCheckout: (projectId: string, branch: string) =>
    post<{ branch: string }>(`/api/files/git-checkout?projectId=${encodeURIComponent(projectId)}`, {
      branch,
    }),
  gitBranchCreate: (projectId: string, name: string) =>
    post<{ branch: string }>(
      `/api/files/git-branch-create?projectId=${encodeURIComponent(projectId)}`,
      { name },
    ),
}

export { fileAPI }
