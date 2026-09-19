import type { StartServerOptions } from '../../server/index.js'
import { DEFAULT_SERVE_PORT, startServer } from '../../server/index.js'
import type { CommandArgs } from '../parser.js'
import { openBrowser, printStartupBanner } from '../utils/output.js'

type RunningHandle = { port: number; authToken?: string; close(): Promise<void> }

type ServeCommandContext = {
  args: CommandArgs
  cwd: string
  serverStarter?: (opts: StartServerOptions) => Promise<RunningHandle>
  banner?: (s: string) => void
  opener?: (url: string) => void | Promise<void>
  /** false = 测试时不挂起进程（不 await 永久 promise）。 */
  hold?: boolean
}

async function runServeCommand(ctx: ServeCommandContext): Promise<void> {
  const port = (ctx.args.options.port as number | undefined) ?? DEFAULT_SERVE_PORT
  const host = (ctx.args.options.host as string | undefined) ?? '127.0.0.1'
  const shouldOpen = (ctx.args.options.open as boolean | undefined) ?? true

  const starter = ctx.serverStarter ?? startServer
  const restore = ctx.args.options.restore as string | undefined
  const handoffPort = ctx.args.options['handoff-port'] as number | undefined
  const handle = await starter({
    port,
    host,
    cwd: ctx.cwd,
    ...(restore ? { restoreFrom: restore } : {}),
    ...(handoffPort ? { handoffPort } : {}),
  })

  // P0-3：认证 token（authEnabled 显式关闭时为 undefined）挂到 URL，
  // 浏览器首访存入 localStorage 并从地址栏移除。
  const tokenQuery = handle.authToken ? `?token=${encodeURIComponent(handle.authToken)}` : ''
  const url = `http://localhost:${handle.port}${tokenQuery}`
  ;(ctx.banner ?? printStartupBanner)(url)

  // 非回环监听警告：绑定 0.0.0.0/局域网 IP 时本机以外的主机均可访问，
  // 安全性完全依赖 token + allowedOrigins——默认行为已收紧为 127.0.0.1。
  const isLoopback =
    host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.startsWith('127.')
  if (!isLoopback) {
    console.warn(
      `[c0de] ⚠ 监听地址为 ${host}（非回环）：本机以外的主机均可访问此服务。\n` +
        `  请确认 security.authEnabled 已开启、token 未泄漏；仅在可信网络使用，或在防火墙限制访问。`,
    )
  }

  if (shouldOpen) {
    const opener = ctx.opener ?? ((u: string) => openBrowser(u))
    await opener(url)
  }

  // 生产：阻塞直到进程被杀；测试：立即返回。
  if (ctx.hold === false) {
    await handle.close()
    return
  }
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      // await close 确保 PGLite WASM 正常关闭刷写 WAL，否则下次启动 dataDir 损坏 abort。
      void handle.close().then(resolve)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })
}

export type { RunningHandle, ServeCommandContext }
export { runServeCommand }
