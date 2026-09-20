import { describe, expect, it, vi } from 'vitest'
import { checkForUpdate, compareSemver, getCurrentVersion } from './version.js'

describe('getCurrentVersion', () => {
  it('reads version from package.json', () => {
    const v = getCurrentVersion()
    expect(v).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('compareSemver', () => {
  it('orders by major.minor.patch', () => {
    expect(compareSemver('0.1.0', '0.2.0')).toBe(-1)
    expect(compareSemver('0.2.0', '0.1.0')).toBe(1)
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
    expect(compareSemver('0.9.9', '1.0.0')).toBe(-1)
  })

  it('strips leading v', () => {
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0)
  })

  // 复现：prerelease 被静默丢弃——'1.0.0-beta' 与 '1.0.0' 判相等。
  // beta 用户永远收不到同版本正式版发布通知。
  it('orders prerelease below release', () => {
    expect(compareSemver('1.0.0-beta', '1.0.0')).toBe(-1)
    expect(compareSemver('1.0.0', '1.0.0-beta')).toBe(1)
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1)
  })

  it('orders prereleases by dot identifiers', () => {
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
    expect(compareSemver('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1)
    expect(compareSemver('1.0.0-beta.2', '1.0.0-beta.2')).toBe(0)
    // 更短前缀为更小：1.0.0-alpha < 1.0.0-alpha.1
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha')).toBe(1)
  })

  // 复现：build metadata 未剥离——'1.2.3+build' 的 patch 位解析为
  // Number('3+build') = NaN，与任何版本比较恒判相等 → 永不提示更新。
  it('ignores build metadata', () => {
    expect(compareSemver('1.2.3+build.4', '1.2.3')).toBe(0)
    expect(compareSemver('1.2.3+build.4', '1.3.0')).toBe(-1)
    expect(compareSemver('1.3.0', '1.2.3+build.4')).toBe(1)
    // NaN 落在 patch 位：'1.2.3+build' 与 '1.2.4' 比较时走到第三段才见 NaN
    expect(compareSemver('1.2.3+build.4', '1.2.4')).toBe(-1)
    expect(compareSemver('1.2.4', '1.2.3+build.4')).toBe(1)
  })
})

describe('checkForUpdate', () => {
  function mockFetch(version: string) {
    return vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version }),
    }) as unknown as typeof fetch
  }

  it('reports update when latest > current', async () => {
    const r = await checkForUpdate({
      fetchImpl: mockFetch('0.2.0'),
      currentVersion: '0.1.0',
      packageName: 'c0de-agent',
    })
    expect(r.hasUpdate).toBe(true)
    expect(r.currentVersion).toBe('0.1.0')
    expect(r.latestVersion).toBe('0.2.0')
  })

  it('reports no update when latest == current', async () => {
    const r = await checkForUpdate({
      fetchImpl: mockFetch('0.1.0'),
      currentVersion: '0.1.0',
      packageName: 'c0de-agent',
    })
    expect(r.hasUpdate).toBe(false)
  })

  it('reports no update when registry behind current', async () => {
    const r = await checkForUpdate({
      fetchImpl: mockFetch('0.0.5'),
      currentVersion: '0.1.0',
      packageName: 'c0de-agent',
    })
    expect(r.hasUpdate).toBe(false)
    expect(r.latestVersion).toBe('0.0.5')
  })

  it('does not throw on network failure (returns hasUpdate false + checkError)', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch
    const r = await checkForUpdate({
      fetchImpl: failing,
      currentVersion: '0.1.0',
      packageName: 'c0de-agent',
    })
    expect(r.hasUpdate).toBe(false)
    expect(r.latestVersion).toBe('0.1.0')
    // P3-8：检查失败与「无更新」区分，消费方给出重试指引
    expect(r.checkError).toBe(true)
  })

  it('treats non-ok response as check failure (checkError)', async () => {
    const notOk = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch
    const r = await checkForUpdate({
      fetchImpl: notOk,
      currentVersion: '0.1.0',
      packageName: 'c0de-agent',
    })
    expect(r.hasUpdate).toBe(false)
    expect(r.checkError).toBe(true)
  })
})
