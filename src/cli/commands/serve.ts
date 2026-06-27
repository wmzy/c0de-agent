import type { CommandArgs } from '../parser.js'
import type { StartServerOptions } from '../../server/index.js'
import { startServer } from '../../server/index.js'
import { openBrowser, printStartupBanner } from '../utils/output.js'

type RunningHandle = { port: number; close(): void }

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
  const port = (ctx.args.options.port as number | undefined) ?? 3000
  const shouldOpen = (ctx.args.options.open as boolean | undefined) ?? true

  const starter = ctx.serverStarter ?? startServer
  const handle = await starter({ port, cwd: ctx.cwd })

  const url = `http://localhost:${handle.port}`
  ;(ctx.banner ?? printStartupBanner)(url)

  if (shouldOpen) {
    const opener = ctx.opener ?? ((u: string) => openBrowser(u))
    await opener(url)
  }

  // 生产：阻塞直到进程被杀；测试：立即返回。
  if (ctx.hold === false) {
    handle.close()
    return
  }
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      handle.close()
      resolve()
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })
}

export type { RunningHandle, ServeCommandContext }
export { runServeCommand }
