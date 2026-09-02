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

  it('strips leading v and prerelease suffix', () => {
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0)
    expect(compareSemver('1.0.0-beta', '1.0.0')).toBe(0)
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

  it('does not throw on network failure (returns hasUpdate false)', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch
    const r = await checkForUpdate({
      fetchImpl: failing,
      currentVersion: '0.1.0',
      packageName: 'c0de-agent',
    })
    expect(r.hasUpdate).toBe(false)
    expect(r.latestVersion).toBe('0.1.0')
  })

  it('treats non-ok response as no-update', async () => {
    const notOk = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch
    const r = await checkForUpdate({
      fetchImpl: notOk,
      currentVersion: '0.1.0',
      packageName: 'c0de-agent',
    })
    expect(r.hasUpdate).toBe(false)
  })
})
