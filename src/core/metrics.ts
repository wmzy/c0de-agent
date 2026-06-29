import { and, eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { toolMetrics } from '../db/schema.js'
import type { ModelToolMetrics } from '../shared/types/tool.js'

/** 非 edit 工具的占位模式（这些工具只有一种实现，无需选择）。 */
export const DEFAULT_TOOL_MODE = 'default'

/** edit 工具在数据不足或历史不达标时使用的保守默认（spec §16.5）。 */
export const DEFAULT_EDIT_MODE = 'diff'

/** 推断某次工具调用使用的模式。
 *  - edit：入参含 `patch` → hashline；否则 diff（search/replace）。
 *  - 其他工具：固定 default（单实现，不参与模式选择）。 */
export function inferToolMode(tool: string, input: unknown): string {
  if (tool === 'edit') {
    if (input !== null && typeof input === 'object' && 'patch' in input) return 'hashline'
    return 'diff'
  }
  return DEFAULT_TOOL_MODE
}

/** DB 行（Date 时间戳）→ 共享 ModelToolMetrics（number 时间戳）。 */
function rowToMetrics(row: typeof toolMetrics.$inferSelect): ModelToolMetrics {
  const lastUsed =
    row.lastUsed instanceof Date ? row.lastUsed.getTime() : new Date(row.lastUsed).getTime()
  return {
    model: row.model,
    tool: row.tool,
    mode: row.mode,
    attempts: row.attempts,
    successes: row.successes,
    failures: row.failures,
    avgLatencyMs: row.avgLatencyMs,
    lastUsed,
  }
}

/** 查某 (model, tool) 所有已记录模式的 metrics。 */
export async function getToolMetrics(
  handle: DB,
  model: string,
  tool: string,
): Promise<ModelToolMetrics[]> {
  const rows = await handle.db
    .select()
    .from(toolMetrics)
    .where(and(eq(toolMetrics.model, model), eq(toolMetrics.tool, tool)))
  return rows.map(rowToMetrics)
}

/**
 * 记录一次工具调用的结果（upsert）。avgLatencyMs 用增量滚动平均更新。
 * PGLite 单进程，select-then-update 无并发竞争。
 */
export async function recordToolMetrics(
  handle: DB,
  model: string,
  tool: string,
  mode: string,
  success: boolean,
  latencyMs: number,
): Promise<void> {
  const whereMode = and(
    eq(toolMetrics.model, model),
    eq(toolMetrics.tool, tool),
    eq(toolMetrics.mode, mode),
  )
  const existing = await handle.db.select().from(toolMetrics).where(whereMode).limit(1)

  if (existing.length === 0) {
    await handle.db.insert(toolMetrics).values({
      model,
      tool,
      mode,
      attempts: 1,
      successes: success ? 1 : 0,
      failures: success ? 0 : 1,
      avgLatencyMs: latencyMs,
      lastUsed: new Date(),
    })
    return
  }

  const row = existing[0]
  if (!row) return
  const attempts = row.attempts + 1
  const successes = row.successes + (success ? 1 : 0)
  const failures = row.failures + (success ? 0 : 1)
  // 滚动平均：新均值 = 旧均值 + (新值 - 旧均值) / n
  const avgLatencyMs = row.avgLatencyMs + (latencyMs - row.avgLatencyMs) / attempts
  await handle.db
    .update(toolMetrics)
    .set({ attempts, successes, failures, avgLatencyMs, lastUsed: new Date() })
    .where(whereMode)
}

/**
 * 根据历史成功率选择最优工具模式（spec §16.5）。
 * - 样本不足（attempts < minSamples）→ defaultMode
 * - 成功率 >= threshold 的模式中取成功率最高（并列取样本最多者）
 * - 无达标模式 → defaultMode
 */
export function selectBestMode(
  metrics: ModelToolMetrics[],
  defaultMode: string,
  opts: { threshold?: number; minSamples?: number } = {},
): string {
  const threshold = opts.threshold ?? 0.8
  const minSamples = opts.minSamples ?? 5
  const eligible = metrics.filter((x) => x.attempts >= minSamples)
  if (eligible.length === 0) return defaultMode
  const good = eligible.filter((x) => x.successes / x.attempts >= threshold)
  if (good.length === 0) return defaultMode
  good.sort((a, b) => {
    const ra = a.successes / a.attempts
    const rb = b.successes / b.attempts
    return rb - ra || b.attempts - a.attempts
  })
  return good[0]?.mode ?? defaultMode
}
