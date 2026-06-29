import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { ModelToolMetrics } from '../shared/types/tool.js'
import {
  DEFAULT_EDIT_MODE,
  DEFAULT_TOOL_MODE,
  getToolMetrics,
  inferToolMode,
  recordToolMetrics,
  selectBestMode,
} from './metrics.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

describe('inferToolMode', () => {
  it('edit 带 patch 字段 → hashline', () => {
    expect(inferToolMode('edit', { patch: '[PATH#HASH]\nSWAP 1-2\nx\n---' })).toBe('hashline')
  })

  it('edit 带 oldText/newText → diff', () => {
    expect(inferToolMode('edit', { path: 'a.ts', oldText: 'x', newText: 'y' })).toBe('diff')
  })

  it('edit 无任何模式字段 → diff（保守默认）', () => {
    expect(inferToolMode('edit', { path: 'a.ts' })).toBe('diff')
  })

  it('非 edit 工具 → default', () => {
    expect(inferToolMode('bash', { command: 'ls' })).toBe(DEFAULT_TOOL_MODE)
    expect(inferToolMode('read', { path: 'a.ts' })).toBe(DEFAULT_TOOL_MODE)
  })

  it('默认模式常量正确', () => {
    expect(DEFAULT_EDIT_MODE).toBe('diff')
    expect(DEFAULT_TOOL_MODE).toBe('default')
  })
})

describe('recordToolMetrics + getToolMetrics', () => {
  let handle: DB

  beforeEach(async () => {
    handle = await setupDB()
  })

  it('首次记录插入新行', async () => {
    await recordToolMetrics(handle, 'gpt-4o', 'edit', 'diff', true, 100)
    const rows = await getToolMetrics(handle, 'gpt-4o', 'edit')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      model: 'gpt-4o',
      tool: 'edit',
      mode: 'diff',
      attempts: 1,
      successes: 1,
      failures: 0,
      avgLatencyMs: 100,
    })
  })

  it('二次记录累加并滚动平均延迟', async () => {
    await recordToolMetrics(handle, 'gpt-4o', 'edit', 'diff', true, 100)
    await recordToolMetrics(handle, 'gpt-4o', 'edit', 'diff', false, 200)
    const rows = await getToolMetrics(handle, 'gpt-4o', 'edit')
    expect(rows[0]).toMatchObject({ attempts: 2, successes: 1, failures: 1 })
    // 滚动平均：100 + (200-100)/2 = 150
    expect(rows[0]?.avgLatencyMs).toBe(150)
  })

  it('不同模式分行存储', async () => {
    await recordToolMetrics(handle, 'gpt-4o', 'edit', 'diff', true, 100)
    await recordToolMetrics(handle, 'gpt-4o', 'edit', 'hashline', true, 50)
    const rows = await getToolMetrics(handle, 'gpt-4o', 'edit')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.mode).sort()).toEqual(['diff', 'hashline'])
  })

  it('查询不存在的 (model, tool) 返回空数组', async () => {
    const rows = await getToolMetrics(handle, 'unknown', 'edit')
    expect(rows).toEqual([])
  })

  it('upsert 不重复插入相同 (model,tool,mode)', async () => {
    await recordToolMetrics(handle, 'gpt-4o', 'edit', 'diff', true, 100)
    await recordToolMetrics(handle, 'gpt-4o', 'edit', 'diff', true, 100)
    await recordToolMetrics(handle, 'gpt-4o', 'edit', 'diff', true, 100)
    const rows = await getToolMetrics(handle, 'gpt-4o', 'edit')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.attempts).toBe(3)
  })
})

describe('selectBestMode', () => {
  const m = (mode: string, attempts: number, successes: number): ModelToolMetrics => ({
    model: 'gpt-4o',
    tool: 'edit',
    mode,
    attempts,
    successes,
    failures: attempts - successes,
    avgLatencyMs: 100,
    lastUsed: 0,
  })

  it('数据不足（attempts < minSamples）→ 默认', () => {
    const metrics = [m('hashline', 3, 3)] // 3 < 5
    expect(selectBestMode(metrics, 'diff')).toBe('diff')
  })

  it('成功率 >= 80% → 选该模式', () => {
    const metrics = [m('hashline', 10, 9), m('diff', 10, 4)]
    expect(selectBestMode(metrics, 'diff')).toBe('hashline')
  })

  it('都不达标 → 默认', () => {
    const metrics = [m('hashline', 10, 5), m('diff', 10, 4)]
    expect(selectBestMode(metrics, 'diff')).toBe('diff')
  })

  it('多个达标 → 取成功率最高', () => {
    const metrics = [m('hashline', 10, 9), m('diff', 20, 18)] // 都 90%/90%
    // 并列成功率时取 attempts 最多 → diff
    expect(selectBestMode(metrics, 'diff')).toBe('diff')
  })

  it('空 metrics → 默认', () => {
    expect(selectBestMode([], 'diff')).toBe('diff')
  })

  it('自定义 threshold', () => {
    const metrics = [m('hashline', 10, 7)] // 70%
    expect(selectBestMode(metrics, 'diff', { threshold: 0.6 })).toBe('hashline')
    expect(selectBestMode(metrics, 'diff', { threshold: 0.8 })).toBe('diff')
  })

  it('自定义 minSamples', () => {
    const metrics = [m('hashline', 3, 3)]
    expect(selectBestMode(metrics, 'diff', { minSamples: 2 })).toBe('hashline')
  })
})
