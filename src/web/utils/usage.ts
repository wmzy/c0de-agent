// 用量/预算口径的共享纯函数。
//
// 背景：成本护栏的「本月 token 用量」与「有效预算」此前在顶栏徽标（TopBar）与
// 用量面板（UsagePanel）各自内联实现，出现过口径漂移：
//  - token 用量：面板累计行算 cacheRead，但预算比较漏算 cacheRead；
//  - 有效预算：顶栏在全局视图回退到项目预算，而服务端 budgetOverageParts 全局
//    口径只认 globalMonthlyBudgetUsd（不回退），导致徽标与服务端判定不一致。
// 此处收敛为单一实现，双端共用；服务端判定（session/usage.ts）口径一致：
// 项目视图取项目预算，全局视图取全局预算，绝不回退。

/** 单次/单月聚合的最小 token 形状（UsageTotals 的子集）。 */
type TokenBucket = {
  inputTokens?: number
  outputTokens?: number
  cacheRead?: number
}

/** 本月 token 口径（input + output + cacheRead），与预算暂停判定同源。 */
export function monthTokenSum(t: TokenBucket | null | undefined): number {
  return (t?.inputTokens ?? 0) + (t?.outputTokens ?? 0) + (t?.cacheRead ?? 0)
}

/** 有效月度成本预算：项目视图取项目预算，全局视图取全局预算（0 = 未设/不限制）。 */
export function resolveEffectiveBudget(
  projectId: string | undefined,
  budgetUsd: number | undefined,
  globalBudgetUsd: number | undefined,
): number {
  return projectId ? (budgetUsd ?? 0) : (globalBudgetUsd ?? 0)
}

/** 有效月度 token 预算：同 resolveEffectiveBudget 的项目/全局二分，绝不回退。 */
export function resolveEffectiveTokenBudget(
  projectId: string | undefined,
  budgetTokens: number | undefined,
  globalBudgetTokens: number | undefined,
): number {
  return projectId ? (budgetTokens ?? 0) : (globalBudgetTokens ?? 0)
}
