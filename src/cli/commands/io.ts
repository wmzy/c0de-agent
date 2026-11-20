/**
 * CLI 命令的 stdout 写入口解析（单一实现）：ctx.write / ctx.out 是测试注入口，
 * 此前 7 个命令文件各持一份缺省回退手写副本（bind 风味 ×3、箭头包装风味 ×3、
 * 带换行变体 ×1），形状漂移无语义差，收敛于此。
 */

/** 最小公共形状：只要求可选 write（各命令 ctx 的其余字段不关心）。 */
type WriteContext = {
  write?: (s: string) => void
}

/** 解析命令写入口：缺省回退 process.stdout（bind 与箭头包装语义等价，统一为 bind）。 */
function resolveWrite(ctx: WriteContext): (s: string) => void {
  return ctx.write ?? process.stdout.write.bind(process.stdout)
}

/** 解析行式输出口（update 命令）：缺省回退对每段输出补 '\n'（保持收敛前行为）。 */
function resolveOutLine(ctx: { out?: (s: string) => void }): (s: string) => void {
  return ctx.out ?? ((s: string) => process.stdout.write(`${s}\n`))
}

/** 解析 stdout 写入口（chat 命令的斜杠拦截与主循环两处成对手抄，收敛于此）。 */
function resolveStdout(ctx: { stdout?: (s: string) => void }): (s: string) => void {
  return ctx.stdout ?? process.stdout.write.bind(process.stdout)
}

/** 解析 stderr 写入口：缺省回退 process.stderr。 */
function resolveStderr(ctx: { stderr?: (s: string) => void }): (s: string) => void {
  return ctx.stderr ?? process.stderr.write.bind(process.stderr)
}

export { resolveOutLine, resolveStderr, resolveStdout, resolveWrite }
