// 目录选择器领域逻辑：移植自 opencode 的 directory-picker-domain，
// 适配 c0de-agent 的 filesystemAPI（listDir/searchDir 注入）。
// 框架无关，可独立单测。参见 docs/superpowers/specs/2026-06-28-directory-picker-design.md
import fuzzysort from 'fuzzysort'

/** 取路径最后一段（目录/文件名），跨平台以 `/` 切分。 */
function getFilename(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? ''
}

/** 清洗输入：取首行、去控制字符、trim。 */
export function cleanPickerInput(value: string) {
  const first = (value ?? '').split(/\r?\n/)[0] ?? ''
  return first
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      return !(code <= 0x1f || code === 0x7f)
    })
    .join('')
    .trim()
}

/** 路径分隔符归一为 `/`，折叠多余斜杠（保留 `//server/share` UNC 前缀）。 */
export function normalizePickerPath(input: string) {
  const value = input.replaceAll('\\', '/')
  if (value.startsWith('//') && !value.startsWith('///'))
    return `//${value.slice(2).replace(/\/+/g, '/')}`
  return value.replace(/\/+/g, '/')
}

/** 规范化盘符：`C:` → `C:/`。 */
export function normalizePickerDrive(input: string) {
  const value = normalizePickerPath(input)
  if (/^[A-Za-z]:$/.test(value)) return `${value}/`
  return value
}

/** 去尾斜杠（保留根 `/`、`//`、`C:/`）。 */
export function trimPickerPath(input: string) {
  const value = normalizePickerDrive(input)
  if (value === '/' || value === '//' || /^[A-Za-z]:\/$/.test(value)) return value
  return value.replace(/\/+$/, '')
}

/** 拼接 base + relative，处理斜杠。 */
export function joinPickerPath(base: string | undefined, relative: string) {
  const root = trimPickerPath(base ?? '')
  const path = trimPickerPath(relative).replace(/^\/+/, '')
  if (!root) return path
  if (!path) return root
  if (root.endsWith('/')) return root + path
  return `${root}/${path}`
}

/** 解析路径的根：`/`、`//server/share`、`C:/` 或空（相对路径）。 */
export function pickerRoot(input: string) {
  const value = normalizePickerDrive(input)
  if (value.startsWith('//')) {
    const [server, share] = value.slice(2).split('/')
    if (server && share) return `//${server}/${share}`
    return '//'
  }
  if (value.startsWith('/')) return '/'
  if (/^[A-Za-z]:\//.test(value)) return value.slice(0, 3)
  return ''
}

/** 解析父目录。 */
export function pickerParent(input: string) {
  const value = trimPickerPath(input)
  const root = pickerRoot(value)
  if (value === root) return value
  if (value === '/' || value === '//' || /^[A-Za-z]:\/$/.test(value)) return value
  const index = value.lastIndexOf('/')
  if (index < root.length) return root
  if (index <= 0) return '/'
  if (index === 2 && /^[A-Za-z]:/.test(value)) return value.slice(0, 3)
  return value.slice(0, index)
}

/** 规范化路径：解析 `.` / `..`。 */
export function canonicalPickerPath(path: string) {
  const value = normalizePickerDrive(path)
  const root = pickerRoot(value)
  const parts = value.slice(root.length).split('/')
  const resolved = parts.reduce<string[]>((output, part) => {
    if (!part || part === '.') return output
    if (part === '..') {
      output.pop()
      return output
    }
    output.push(part)
    return output
  }, [])
  return joinPickerPath(root, resolved.join('/'))
}

/** 相对路径：path 相对 base，不在 base 下返回 undefined。 */
export function pickerRelativePath(base: string | undefined, path: string) {
  if (!base) return
  const rootPath = canonicalPickerPath(base)
  const targetPath = canonicalPickerPath(path)
  const insensitive = /^[A-Za-z]:\//.test(rootPath) || rootPath.startsWith('//')
  const root = insensitive ? rootPath.toLowerCase() : rootPath
  const target = insensitive ? targetPath.toLowerCase() : targetPath
  if (target === root) return ''
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (!target.startsWith(prefix)) return
  return targetPath.slice(prefix.length)
}

/** 绝对路径转 `~` 显示（在 home 下时）。 */
function pickerTilde(absolute: string, home: string) {
  const path = trimPickerPath(absolute)
  if (!home) return ''
  const root = trimPickerPath(home)
  if (/^[A-Za-z]:\//.test(root)) return ''
  if (path === root) return '~'
  if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`
  return ''
}

/** 显示路径：home 下用 `~`；Windows 路径用 `\`。 */
export function displayPickerPath(path: string, _input: string, home: string) {
  const value = trimPickerPath(path)
  if (/^[A-Za-z]:\//.test(trimPickerPath(home)) || /^[A-Za-z]:\//.test(value))
    return value.replaceAll('/', '\\')
  return pickerTilde(value, home) || value
}

/** 输入转绝对路径（支持 `~`、相对 base）。 */
export function pickerAbsoluteInput(input: string, home: string, current: string) {
  const value = normalizePickerDrive(input).replace(/^~(?=\/|$)/, normalizePickerDrive(home))
  const absolute = pickerRoot(value) ? value : joinPickerPath(current, value)
  return canonicalPickerPath(absolute)
}

/** 从搜索结果取当前 query 对应的建议。 */
export function currentPickerSuggestions<T>(
  result: { query: string; items: readonly T[] } | undefined,
  query: string,
) {
  if (result?.query !== query) return []
  return result.items
}

/** 建议列表上下移动索引（循环）。 */
export function nextSuggestionIndex(current: number, delta: -1 | 1, count: number) {
  if (count === 0) return -1
  return (((current + delta) % count) + count) % count
}

/** 标记一次导航请求是否仍为最新（防止竞态）。 */
export function activeTreeNavigation(request: number, current: number) {
  return request === current
}

/** 目录搜索访问接口（生产注入 filesystemAPI，测试注入 mock）。 */
type DirectorySearchAccess = {
  /** 列出目录的直接子目录（已规范化为绝对路径）。 */
  listDir: (directory: string) => Promise<Array<{ name: string; absolute: string }>>
  /** 递归搜索目录（返回相对 directory 的目录路径）。 */
  searchDir: (directory: string, query: string, limit: number) => Promise<string[]>
  /** home 绝对路径。 */
  home: () => string
  /** 默认基目录。 */
  base: () => string | undefined
}

/**
 * 创建目录搜索函数。移植自 opencode 的同名实现。
 *
 * - 纯名字输入（无 `/`、无 `~`、非绝对）→ searchDir 递归搜索整树。
 * - 路径输入 → 分段 fuzzysort 模糊匹配，支持 `..`，目录列表缓存，竞态取消。
 *
 * 返回 `async (filter) => string[]`（绝对路径数组）。
 */
export function createDirectorySearch(args: DirectorySearchAccess) {
  const cache = new Map<string, Promise<Array<{ name: string; absolute: string }>>>()
  let current = 0

  const scoped = (value: string) => {
    const base = args.base()
    if (!base) return
    const raw = normalizePickerDrive(value)
    if (!raw) return { directory: trimPickerPath(base), path: '' }
    const home = args.home()
    if (raw === '~') return { directory: trimPickerPath(home || base), path: '' }
    if (raw.startsWith('~/')) return { directory: trimPickerPath(home || base), path: raw.slice(2) }
    const root = pickerRoot(raw)
    if (root) return { directory: trimPickerPath(root), path: raw.slice(root.length) }
    return { directory: trimPickerPath(base), path: raw }
  }

  const directories = async (directory: string) => {
    const key = trimPickerPath(directory)
    const existing = cache.get(key)
    if (existing) return existing
    const request = args
      .listDir(key)
      .catch(() => [] as Array<{ name: string; absolute: string }>)
      .then((nodes) =>
        nodes.map((node) => ({
          name: node.name,
          absolute: trimPickerPath(normalizePickerDrive(node.absolute)),
        })),
      )
    cache.set(key, request)
    return request
  }

  const match = async (directory: string, query: string, limit: number) => {
    const items = await directories(directory)
    if (!query) return items.slice(0, limit).map((item) => item.absolute)
    return fuzzysort.go(query, items, { key: 'name', limit }).map((item) => item.obj.absolute)
  }

  return async (filter: string): Promise<string[]> => {
    const token = ++current
    const active = () => token === current
    const value = cleanPickerInput(filter)
    const input = scoped(value)
    if (!input) return []
    const raw = normalizePickerDrive(value)
    const pathInput = raw.startsWith('~') || !!pickerRoot(raw) || raw.includes('/')
    const query = normalizePickerDrive(input.path)
    if (!pathInput) {
      // 纯名字：服务端递归搜索
      const results = await args
        .searchDir(input.directory, query, 50)
        .then((items) => items ?? [])
        .catch(() => [] as string[])
      if (!active()) return []
      return results.map((path) => joinPickerPath(input.directory, path)).slice(0, 50)
    }
    // 路径输入：分段模糊匹配
    const segments = query.replace(/^\/+/, '').split('/')
    const head = segments.slice(0, -1).filter((part) => part && part !== '.')
    const tail = segments.at(-1) ?? ''
    let paths = [input.directory]
    for (const part of head) {
      if (!active()) return []
      if (part === '..') {
        paths = paths.map(pickerParent)
        continue
      }
      paths = Array.from(
        new Set((await Promise.all(paths.map((path) => match(path, part, 4)))).flat()),
      ).slice(0, 12)
      if (!active() || paths.length === 0) return []
    }
    const matches = Array.from(
      new Set((await Promise.all(paths.map((path) => match(path, tail, 50)))).flat()),
    )
    if (!active()) return []
    const base = raw.startsWith('~') ? trimPickerPath(input.directory) : ''
    if (raw.endsWith('/') || !tail) {
      return Array.from(new Set([base, ...matches].filter(Boolean))).slice(0, 50)
    }
    const target = matches.find((path) => getFilename(path).toLowerCase() === tail.toLowerCase())
    if (!target) return matches.slice(0, 50)
    const children = await match(target, '', 30)
    if (!active()) return []
    return Array.from(new Set([base, ...matches, ...children].filter(Boolean))).slice(0, 50)
  }
}

export type { DirectorySearchAccess }
