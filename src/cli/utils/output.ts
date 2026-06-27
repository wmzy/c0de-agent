import { spawn } from 'node:child_process'

function platformOpener(platform: string): string {
  if (platform === 'darwin') return 'open'
  if (platform === 'win32') return 'start'
  return 'xdg-open'
}

type SpawnLike = (cmd: string, args: string[]) => unknown

type OpenBrowserOptions = {
  platform?: string
  /** 测试注入。 */
  spawnFn?: SpawnLike
}

async function openBrowser(url: string, opts: OpenBrowserOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform
  const cmd = platformOpener(platform)
  const doSpawn: SpawnLike =
    opts.spawnFn ??
    ((c, a) => {
      const child = spawn(c, a, { detached: true, stdio: 'ignore' })
      child.unref()
      return child
    })
  doSpawn(cmd, [url])
}

function printStartupBanner(
  url: string,
  write: (s: string) => void = process.stderr.write.bind(process.stderr),
): void {
  write(`\nc0de-agent server running at ${url}\nOpen this URL in your browser.\n\n`)
}

export type { OpenBrowserOptions, SpawnLike }
export { openBrowser, platformOpener, printStartupBanner }
