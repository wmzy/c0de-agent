import { afterEach, describe, expect, it, vi } from 'vitest'
import { storageGet, storageRemove, storageSet } from '@/utils/storage.js'

/**
 * 模拟存储被禁/配额耗尽：localStorage 的读/写/删一律抛错（站点数据被禁时
 * SecurityError，配额耗尽时 QuotaExceededError）。happy-dom 的 localStorage
 * 方法不在 Storage.prototype 上（实例自有），故按实例 spy。
 */
function denyStorage(): void {
  const deny = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  }
  vi.spyOn(localStorage, 'getItem').mockImplementation(deny)
  vi.spyOn(localStorage, 'setItem').mockImplementation(deny)
  vi.spyOn(localStorage, 'removeItem').mockImplementation(deny)
}

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('storage helpers', () => {
  it('正常存储下读写删透传', () => {
    storageSet('k', 'v')
    expect(storageGet('k')).toBe('v')
    storageRemove('k')
    expect(storageGet('k')).toBeNull()
  })

  // 复现：裸 localStorage 调用在存储被禁时抛 SecurityError——读点在 useState
  // 初始化器（渲染路径）即白屏，写点在 effect 里击穿错误边界。
  it('存储不可用时读返回 null、写删不抛错（降级为无持久化）', () => {
    denyStorage()
    expect(storageGet('k')).toBeNull()
    expect(() => storageSet('k', 'v')).not.toThrow()
    expect(() => storageRemove('k')).not.toThrow()
  })
})
