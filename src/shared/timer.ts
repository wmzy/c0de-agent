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
