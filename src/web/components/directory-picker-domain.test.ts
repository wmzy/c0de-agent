// directory-picker-domain 单元测试。
// 来源：移植自 opencode directory-picker-domain，对应 src/web/components/directory-picker-domain.ts。
// 归并建议：domain 为独立模块，单元测试独立成文件；纯函数与 createDirectorySearch 在此集中验证。
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalPickerPath,
  cleanPickerInput,
  createDirectorySearch,
  displayPickerPath,
  joinPickerPath,
  nextSuggestionIndex,
  normalizePickerDrive,
  pickerAbsoluteInput,
  pickerParent,
  pickerRoot,
  trimPickerPath,
} from './directory-picker-domain.js'

describe('cleanPickerInput', () => {
  it('取首行、去控制字符、trim', () => {
    expect(cleanPickerInput('  /a/b  ')).toBe('/a/b')
    expect(cleanPickerInput('line1\nline2')).toBe('line1')
    expect(cleanPickerInput('a\u0000b\u007F')).toBe('ab')
    expect(cleanPickerInput(undefined as unknown as string)).toBe('')
  })
})

describe('路径规范化', () => {
  it('normalizePickerDrive 补盘符斜杠', () => {
    expect(normalizePickerDrive('C:')).toBe('C:/')
    expect(normalizePickerDrive('C:/x')).toBe('C:/x')
  })

  it('trimPickerPath 去尾斜杠但保留根', () => {
    expect(trimPickerPath('/a/b/')).toBe('/a/b')
    expect(trimPickerPath('/')).toBe('/')
    expect(trimPickerPath('C:/')).toBe('C:/')
  })

  it('joinPickerPath 拼接', () => {
    expect(joinPickerPath('/a', 'b')).toBe('/a/b')
    expect(joinPickerPath('/a/', 'b')).toBe('/a/b')
    expect(joinPickerPath('/a', '')).toBe('/a')
    expect(joinPickerPath(undefined, 'b')).toBe('b')
  })

  it('canonicalPickerPath 解析 . 与 ..', () => {
    expect(canonicalPickerPath('/a/./b')).toBe('/a/b')
    expect(canonicalPickerPath('/a/../b')).toBe('/b')
    expect(canonicalPickerPath('/a/b/../c')).toBe('/a/c')
  })
})

describe('pickerRoot', () => {
  it.each([
    ['/a/b', '/'],
    ['/', '/'],
    ['C:/x', 'C:/'],
    ['//server/share/sub', '//server/share'],
    ['relative', ''],
  ])('%s -> %s', (input, expected) => {
    expect(pickerRoot(input)).toBe(expected)
  })
})

describe('pickerParent', () => {
  it.each([
    ['/a/b/c', '/a/b'],
    ['/a', '/'],
    ['/', '/'],
    ['C:/x/y', 'C:/x'],
    ['C:/x', 'C:/'],
    ['//server/share/dir', '//server/share'],
  ])('%s -> %s', (input, expected) => {
    expect(pickerParent(input)).toBe(expected)
  })

  it('父级跨越 .. 时回到根', () => {
    expect(pickerParent('/a').slice(0, 1)).toBe('/')
  })
})

describe('displayPickerPath', () => {
  it('home 下用 ~ 缩写', () => {
    expect(displayPickerPath('/home/user/projects', '/home/user/projects/x', '/home/user')).toBe(
      '~/projects',
    )
  })

  it('非 home 下用绝对路径', () => {
    expect(displayPickerPath('/opt/x', '/opt/x', '/home/user')).toBe('/opt/x')
  })
})

describe('pickerAbsoluteInput', () => {
  it('~ 展开 + 相对解析', () => {
    expect(pickerAbsoluteInput('~', '/home/user', '/cwd')).toBe('/home/user')
    expect(pickerAbsoluteInput('~/proj', '/home/user', '/cwd')).toBe('/home/user/proj')
    expect(pickerAbsoluteInput('rel', '/home/user', '/cwd')).toBe('/cwd/rel')
    expect(pickerAbsoluteInput('/abs/x', '/home/user', '/cwd')).toBe('/abs/x')
  })
})

describe('nextSuggestionIndex', () => {
  it('循环移动', () => {
    expect(nextSuggestionIndex(-1, 1, 3)).toBe(0)
    expect(nextSuggestionIndex(2, 1, 3)).toBe(0)
    expect(nextSuggestionIndex(0, -1, 3)).toBe(2)
    expect(nextSuggestionIndex(0, 1, 0)).toBe(-1)
  })
})

describe('createDirectorySearch', () => {
  type ListDirFn = (directory: string) => Promise<Array<{ name: string; absolute: string }>>
  type SearchDirFn = (directory: string, query: string, limit: number) => Promise<string[]>

  function makeAccess(
    opts: {
      listDirResult?: Array<{ name: string; absolute: string }>
      listDirImpl?: ListDirFn
      searchDirResult?: string[]
      searchDirImpl?: SearchDirFn
    } = {},
  ) {
    const listDir = vi.fn<ListDirFn>(opts.listDirImpl ?? (async () => opts.listDirResult ?? []))
    const searchDir = vi.fn<SearchDirFn>(
      opts.searchDirImpl ?? (async () => opts.searchDirResult ?? []),
    )
    const search = createDirectorySearch({
      listDir,
      searchDir,
      home: () => '/home/user',
      base: () => '/home/user',
    })
    return { search, listDir, searchDir }
  }

  it('纯名字输入走 searchDir 递归搜索', async () => {
    const { search, searchDir } = makeAccess({ searchDirResult: ['projects/c0de'] })
    const result = await search('c0de')
    expect(searchDir).toHaveBeenCalledWith('/home/user', 'c0de', 50)
    expect(result).toEqual(['/home/user/projects/c0de'])
  })

  it('路径输入走分段模糊匹配', async () => {
    const { search, listDir } = makeAccess({
      listDirResult: [
        { name: 'projects', absolute: '/home/user/projects' },
        { name: 'docs', absolute: '/home/user/docs' },
      ],
    })
    // ~ 锢定到 home 作为基目录，后续 'pro' 走 fuzzysort 分段匹配
    const result = await search('~/pro')
    expect(listDir).toHaveBeenCalledWith('/home/user')
    // fuzzysort 命中 projects（'pro' 子串）
    expect(result.some((p) => p.includes('projects'))).toBe(true)
  })

  it('listDir 结果被缓存（同目录只请求一次）', async () => {
    const { search, listDir } = makeAccess({
      listDirResult: [{ name: 'a', absolute: '/home/user/a' }],
    })
    await search('/home/user/x')
    await search('/home/user/y')
    expect(listDir).toHaveBeenCalledTimes(1)
  })

  it('竞态：后发请求使先发的结果丢弃', async () => {
    let resolveFirst: (v: string[]) => void = () => {}
    let call = 0
    const { search } = makeAccess({
      searchDirImpl: async () => {
        call += 1
        if (call === 1) return new Promise<string[]>((r) => (resolveFirst = r))
        return ['quick']
      },
    })
    const first = search('slow')
    const second = search('quick')
    resolveFirst(['stale'])
    expect(await first).toEqual([])
    expect(await second).toEqual(['/home/user/quick'])
  })

  it('listDir 失败不抛出（返回空）', async () => {
    const { search, listDir } = makeAccess({
      listDirImpl: async () => {
        throw new Error('net')
      },
    })
    const result = await search('/home/user/pro')
    expect(listDir).toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it('base 为空时返回空', async () => {
    const search = createDirectorySearch({
      listDir: vi.fn<ListDirFn>(async () => []),
      searchDir: vi.fn<SearchDirFn>(async () => []),
      home: () => '',
      base: () => undefined,
    })
    expect(await search('anything')).toEqual([])
  })
})
