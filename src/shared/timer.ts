/**
 * Node timer 的 32 位安全上限：setTimeout/setInterval 的延迟超过
 * 2^31-1（2147483647ms ≈ 24.8 天）会被引擎钳到 1ms（TimeoutOverflowWarning）。
 *
 * 任何把用户输入/配置/插件声明直接作为 timer 延迟的调用点都必须先经本常量
 * 钳制或校验——否则「超长超时/超长间隔」会变成「立即触发」：命令刚 spawn 即
 * 被杀、间隔变成每毫秒狂刷。同类值此前散落定义（llm/retry.ts 的
 * RETRY_MAX_DELAY），现已收敛为单一来源。
 */
export const MAX_TIMER_MS = 2_147_483_647

/**
 * 归一化「用户输入/配置/插件声明」提供的 timer 时长（毫秒）。
 *
 * 引擎行为：非有限（NaN/±Infinity）或超 32 位上限的延迟都被钳到 1ms。
 * 两种退化都必须拦截，否则语义反转——
 *  - 上界：写「超长超时/间隔」本意是「等很久/少检查」，实际立即触发/每毫秒狂刷；
 *  - 下界：0/负数（如「不检查」的配置写法）同样落到 1ms 轮询，比上界情形更糟。
 *
 * @param ms           外部提供的时长；undefined 视为未设置
 * @param fallback     非法值（非有限或 < minInclusive）的回落值
 * @param minInclusive 合法下界（一次性延迟可为 0=立即；间隔类传 1）
 */
export function clampTimerDelay(
  ms: number | undefined,
  fallback: number,
  minInclusive = 0,
): number {
  if (ms === undefined || !Number.isFinite(ms) || ms < minInclusive) return fallback
  return Math.min(ms, MAX_TIMER_MS)
}
