// gh-resolver 测试：全部经注入的 mock exec（不真调 gh CLI）。
// 覆盖文法解析、默认 repo 解析与缓存、错误翻译（未安装/未登录/超时）、截断。
import { describe, expect, it, vi } from 'vitest'
import type { URLResolveContext } from '../../shared/types/tool.js'
import { createGhResolver, type GhExecFn, type GhResolvers } from './gh-resolver.js'

const ctx: URLResolveContext = { cwd: '/repo', session: { id: 's1', cwd: '/repo' } }

/** gh repo view 的标准 mock 应答。 */
const REPO_VIEW = { stdout: '{"nameWithOwner":"acme/app"}', stderr: '' }

function makeIssueBody(size = 0): string {
  return 'x'.repeat(size)
}

/** 构造带 mock exec 的 resolvers；handler 按参数分派应答。 */
function makeResolvers(
  handler: (
    args: string[],
  ) => { stdout: string; stderr: string } | Promise<{ stdout: string; stderr: string }>,
  opts?: { defaultRepoTtlMs?: number },
): { resolvers: GhResolvers; exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn<GhExecFn>(async (args) => handler(args))
  const resolvers = createGhResolver({ exec, ...opts })
  return { resolvers, exec }
}

function issueJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 42,
    title: 'Fix the thing',
    state: 'OPEN',
    stateReason: null,
    author: { login: 'alice' },
    labels: [{ name: 'bug' }, { name: 'ui' }],
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-02T10:00:00Z',
    url: 'https://github.com/acme/app/issues/42',
    body: 'Body text',
    comments: [{ author: { login: 'bob' }, body: 'First!', createdAt: '2026-11-02T11:00:00Z' }],
    ...overrides,
  })
}

function prJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 7,
    title: 'Add feature',
    state: 'OPEN',
    isDraft: false,
    author: { login: 'bob' },
    labels: [],
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-02T10:00:00Z',
    mergedAt: null,
    baseRefName: 'main',
    headRefName: 'feature',
    additions: 120,
    deletions: 30,
    changedFiles: 4,
    url: 'https://github.com/acme/app/pull/7',
    body: 'PR body',
    comments: [],
    ...overrides,
  })
}

describe('issue:// 文法与渲染', () => {
  it('issue://N 短格式：默认 repo 解析后调 gh issue view', async () => {
    const { resolvers, exec } = makeResolvers((args) =>
      args[0] === 'repo' ? REPO_VIEW : { stdout: issueJson(), stderr: '' },
    )
    const content = await resolvers.issueResolver.resolve('issue://42', ctx)
    expect(exec).toHaveBeenCalledWith(['repo', 'view', '--json', 'nameWithOwner'], '/repo')
    expect(exec).toHaveBeenCalledWith(
      ['issue', 'view', '42', '--repo', 'acme/app', '--json', expect.stringContaining('number')],
      '/repo',
    )
    expect(content).toContain('# Issue acme/app#42: Fix the thing')
    expect(content).toContain('- **State:** open')
    expect(content).toContain('- **Author:** @alice')
    expect(content).toContain('- **Labels:** bug, ui')
    expect(content).toContain('- **URL:** https://github.com/acme/app/issues/42')
    expect(content).toContain('## Body')
    expect(content).toContain('## Comments (1)')
    expect(content).toContain('**@bob** · 2026-11-02T11:00:00Z')
    expect(content).toContain('First!')
  })

  it('issue://owner/repo/N 全限定：跳过默认 repo 解析', async () => {
    const { resolvers, exec } = makeResolvers(() => ({
      stdout: issueJson({ number: 99 }),
      stderr: '',
    }))
    const content = await resolvers.issueResolver.resolve('issue://other/lib/99', ctx)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith(
      ['issue', 'view', '99', '--repo', 'other/lib', '--json', expect.any(String)],
      '/repo',
    )
    expect(content).toContain('# Issue other/lib#99')
  })

  it('非法文法报可用形态', async () => {
    const { resolvers } = makeResolvers(() => REPO_VIEW)
    await expect(resolvers.issueResolver.resolve('issue://', ctx)).rejects.toThrow(
      /Invalid issue:\/\/ URL/,
    )
    await expect(resolvers.issueResolver.resolve('issue://abc', ctx)).rejects.toThrow(
      /Invalid issue:\/\/ number: abc/,
    )
    await expect(resolvers.issueResolver.resolve('issue://owner/repo', ctx)).rejects.toThrow(
      /missing item number/,
    )
    await expect(resolvers.issueResolver.resolve('issue://owner/repo/1/2', ctx)).rejects.toThrow(
      /Issues do not have a diff/,
    )
    await expect(resolvers.issueResolver.resolve('issue://0', ctx)).rejects.toThrow(
      /Invalid issue:\/\/ number: 0/,
    )
  })

  it('缺省字段与空值容错渲染', async () => {
    const { resolvers } = makeResolvers(() => ({
      stdout: JSON.stringify({ number: 5, title: 'bare', state: 'CLOSED' }),
      stderr: '',
    }))
    const content = await resolvers.issueResolver.resolve('issue://owner/repo/5', ctx)
    expect(content).toContain('# Issue owner/repo#5: bare')
    expect(content).toContain('- **State:** closed')
    expect(content).toContain('- **Author:** @?')
    expect(content).toContain('_No body._')
    expect(content).not.toContain('## Comments')
  })
})

describe('pr:// 文法与渲染', () => {
  it('pr://N 渲染详情并附 diff 提示', async () => {
    const { resolvers, exec } = makeResolvers((args) =>
      args[0] === 'repo' ? REPO_VIEW : { stdout: prJson(), stderr: '' },
    )
    const content = await resolvers.prResolver.resolve('pr://7', ctx)
    expect(exec).toHaveBeenCalledWith(
      ['pr', 'view', '7', '--repo', 'acme/app', '--json', expect.stringContaining('isDraft')],
      '/repo',
    )
    expect(content).toContain('# Pull Request acme/app#7: Add feature')
    expect(content).toContain('- **Branch:** feature → main')
    expect(content).toContain('- **Changes:** +120 −30 across 4 files')
    expect(content).toContain('Diff: `pr://acme/app/7/diff`')
  })

  it('draft PR 状态带 [draft] 标记', async () => {
    const { resolvers } = makeResolvers(() => ({ stdout: prJson({ isDraft: true }), stderr: '' }))
    const content = await resolvers.prResolver.resolve('pr://owner/repo/7', ctx)
    expect(content).toContain('- **State:** open [draft]')
  })

  it('pr://N/diff 与全限定 diff：调 gh pr diff 并围栏渲染', async () => {
    const { resolvers, exec } = makeResolvers((args) =>
      args[0] === 'repo'
        ? REPO_VIEW
        : args[0] === 'pr' && args[1] === 'diff'
          ? { stdout: 'diff --git a/x b/x\n+hello\n', stderr: '' }
          : { stdout: prJson(), stderr: '' },
    )
    const short = await resolvers.prResolver.resolve('pr://7/diff', ctx)
    expect(short).toContain('# Pull Request Diff: acme/app#7')
    expect(short).toContain('```diff')
    expect(short).toContain('+hello')
    const full = await resolvers.prResolver.resolve('pr://other/lib/8/diff', ctx)
    expect(full).toContain('# Pull Request Diff: other/lib#8')
    expect(exec).toHaveBeenCalledWith(['pr', 'diff', '8', '--repo', 'other/lib'], '/repo')
  })

  it('空 diff 如实呈现', async () => {
    const { resolvers } = makeResolvers(() => ({ stdout: '\n', stderr: '' }))
    const content = await resolvers.prResolver.resolve('pr://owner/repo/3/diff', ctx)
    expect(content).toContain('_Empty diff._')
  })

  it('diff 子路径（/all、/<i>）一期不支持', async () => {
    const { resolvers } = makeResolvers(() => REPO_VIEW)
    await expect(resolvers.prResolver.resolve('pr://7/diff/all', ctx)).rejects.toThrow(
      /Only pr:\/\/<n>\/diff is supported/,
    )
    await expect(resolvers.prResolver.resolve('pr://7/diff/2', ctx)).rejects.toThrow(
      /diff sub-path "2"/,
    )
    await expect(resolvers.prResolver.resolve('pr://owner/repo/7/patch', ctx)).rejects.toThrow(
      /Invalid pr:\/\/ suffix "patch"/,
    )
    await expect(resolvers.prResolver.resolve('pr://owner/diff', ctx)).rejects.toThrow(
      /missing item number/,
    )
  })
})

describe('默认 repo 解析与缓存', () => {
  it('60s 内同 cwd 只解析一次', async () => {
    const { resolvers, exec } = makeResolvers((args) =>
      args[0] === 'repo' ? REPO_VIEW : { stdout: issueJson(), stderr: '' },
    )
    await resolvers.issueResolver.resolve('issue://1', ctx)
    await resolvers.issueResolver.resolve('issue://2', ctx)
    expect(exec.mock.calls.filter(([args]) => args[0] === 'repo')).toHaveLength(1)
  })

  it('TTL 过期后重新解析', async () => {
    const { resolvers, exec } = makeResolvers(
      (args) => (args[0] === 'repo' ? REPO_VIEW : { stdout: issueJson(), stderr: '' }),
      { defaultRepoTtlMs: 0 },
    )
    await resolvers.issueResolver.resolve('issue://1', ctx)
    await resolvers.issueResolver.resolve('issue://2', ctx)
    expect(exec.mock.calls.filter(([args]) => args[0] === 'repo')).toHaveLength(2)
  })

  it('默认 repo 解析失败：错误引导全限定形态', async () => {
    const { resolvers } = makeResolvers(() => ({ stdout: 'not json', stderr: '' }))
    await expect(resolvers.issueResolver.resolve('issue://42', ctx)).rejects.toThrow(
      /could not resolve the default repo[\s\S]*Use issue:\/\/<owner>\/<repo>\/42 instead/,
    )
  })

  it('不同 cwd 的缓存互不干扰', async () => {
    const { resolvers, exec } = makeResolvers((args) =>
      args[0] === 'repo'
        ? { stdout: '{"nameWithOwner":"acme/app"}', stderr: '' }
        : { stdout: issueJson(), stderr: '' },
    )
    const otherCtx: URLResolveContext = { cwd: '/other', session: { id: 's1', cwd: '/other' } }
    await resolvers.issueResolver.resolve('issue://1', ctx)
    await resolvers.issueResolver.resolve('issue://1', otherCtx)
    expect(exec.mock.calls.filter(([args]) => args[0] === 'repo')).toHaveLength(2)
  })
})

describe('gh 错误翻译', () => {
  it('未安装 gh（ENOENT）引导安装', async () => {
    const { resolvers } = makeResolvers(() => {
      const e = new Error('spawn gh ENOENT') as NodeJS.ErrnoException
      e.code = 'ENOENT'
      return Promise.reject(e)
    })
    await expect(resolvers.issueResolver.resolve('issue://owner/repo/1', ctx)).rejects.toThrow(
      /gh CLI not found on PATH/,
    )
  })

  it('未登录引导 gh auth login（含 GH_TOKEN 提示）', async () => {
    const { resolvers } = makeResolvers(() => {
      const e = new Error('Command failed')
      ;(e as { stderr?: string }).stderr =
        'To get started with GitHub CLI, please run:  gh auth login\n'
      return Promise.reject(e)
    })
    await expect(resolvers.issueResolver.resolve('issue://owner/repo/1', ctx)).rejects.toThrow(
      /gh is not authenticated[\s\S]*gh auth login[\s\S]*GH_TOKEN/,
    )
  })

  it('超时如实报告秒数', async () => {
    const { resolvers } = makeResolvers(() => {
      const e = new Error('Command timed out after 15000 milliseconds: gh issue view 1')
      ;(e as { killed?: boolean }).killed = true
      return Promise.reject(e)
    })
    await expect(resolvers.issueResolver.resolve('issue://owner/repo/1', ctx)).rejects.toThrow(
      /timed out after 15s/,
    )
  })

  it('gh 业务失败透传 stderr 首行', async () => {
    const { resolvers } = makeResolvers(() => {
      const e = new Error('Command failed with exit code 1')
      ;(e as { stderr?: string }).stderr =
        'GraphQL: Could not resolve to an Issue with number of 999.\n'
      return Promise.reject(e)
    })
    await expect(resolvers.issueResolver.resolve('issue://owner/repo/999', ctx)).rejects.toThrow(
      /Could not resolve to an Issue/,
    )
  })
})

describe('输出截断', () => {
  it('超过 100KB 的渲染内容截断并附提示', async () => {
    const big = makeIssueBody(120 * 1024)
    const { resolvers } = makeResolvers(() => ({ stdout: issueJson({ body: big }), stderr: '' }))
    const content = await resolvers.issueResolver.resolve('issue://owner/repo/1', ctx)
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(110 * 1024)
    expect(content).toContain('Output truncated')
  })

  it('100KB 内不截断', async () => {
    const { resolvers } = makeResolvers(() => ({
      stdout: issueJson({ body: 'short' }),
      stderr: '',
    }))
    const content = await resolvers.issueResolver.resolve('issue://owner/repo/1', ctx)
    expect(content).not.toContain('Output truncated')
    expect(content).toContain('short')
  })
})

describe('数据源注入', () => {
  it('fetchJson 覆盖 JSON 通道（exec 仍承担 diff）', async () => {
    const exec = vi.fn<GhExecFn>(async () => ({ stdout: 'diff --git', stderr: '' }))
    const fetchJson = vi.fn(async (args: string[]) => {
      if (args[0] === 'repo') return { nameWithOwner: 'injected/repo' }
      return JSON.parse(issueJson())
    })
    const resolvers = createGhResolver({ exec, fetchJson })
    const content = await resolvers.issueResolver.resolve('issue://5', ctx)
    expect(content).toContain('# Issue injected/repo#42')
    expect(exec).not.toHaveBeenCalled()
    const diff = await resolvers.prResolver.resolve('pr://5/diff', ctx)
    expect(diff).toContain('```diff')
    expect(exec).toHaveBeenCalledTimes(1)
  })
})
