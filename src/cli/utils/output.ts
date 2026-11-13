import { spawn } from 'node:child_process'

/** 平台打开器：win32 的 start 是 cmd 内建命令而非可执行文件，直接 spawn 必
 *  ENOENT——须经 cmd /c 调用，且空串标题参数占住 start 的「窗口标题槽」，
 *  防 URL 被当成标题（start 的首个引号参数是标题而非目标）。 */
type OpenerSpec = { command: string; prefixArgs: string[] }

function platformOpener(platform: string): OpenerSpec {
  if (platform === 'darwin') return { command: 'open', prefixArgs: [] }
  if (platform === 'win32') return { command: 'cmd', prefixArgs: ['/c', 'start', ''] }
  return { command: 'xdg-open', prefixArgs: [] }
}

type SpawnLike = (cmd: string, args: string[]) => unknown

type OpenBrowserOptions = {
  platform?: string
  /** 测试注入。 */
  spawnFn?: SpawnLike
}

async function openBrowser(url: string, opts: OpenBrowserOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform
  const doSpawn: SpawnLike =
    opts.spawnFn ??
    ((c, a) => {
      const child = spawn(c, a, { detached: true, stdio: 'ignore' })
      // 尽力而为的兜底：opener 缺失（无桌面环境的 xdg-open）时 spawn 异步派发
      // 'error' 事件，无监听器会以 ERR_UNHANDLED_ERROR 击穿进程（serve --open
      // 直接崩）。打不开无碍——启动横幅已印出 URL，降级为一行 stderr 提示。
      child.on('error', (e) => {
        process.stderr.write(`[open] 无法自动打开浏览器（${c}：${(e as Error).message}）\n`)
      })
      child.unref()
      return child
    })
  const { command, prefixArgs } = platformOpener(platform)
  doSpawn(command, [...prefixArgs, url])
}

function printStartupBanner(
  url: string,
  write: (s: string) => void = process.stderr.write.bind(process.stderr),
): void {
  write(`\nc0de-agent server running at ${url}\nOpen this URL in your browser.\n\n`)
}

export type { OpenBrowserOptions, SpawnLike }
export { openBrowser, platformOpener, printStartupBanner }
