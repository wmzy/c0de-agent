import { readFileSync } from 'node:fs'

// 版本检查（spec §18.1）：查询 npm registry 比对当前版本。

type UpdateCheckResult = {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  releaseNotes?: string
}

type CheckOptions = {
  fetchImpl?: typeof fetch
  packageName?: string
  currentVersion?: string
  registryUrl?: string
}

const DEFAULT_PACKAGE = 'c0de-agent'
const DEFAULT_VERSION = '0.1.0'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/**
 * 读取当前安装版本（package.json 的 version 字段）。
 * src/dev 与 dist 两种布局下 `../../package.json` 都指向包根；读取失败回退常量。
 */
function getCurrentVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { version?: unknown }
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version
  } catch {
    // 打包布局异常：回退保守常量
  }
  return DEFAULT_VERSION
}

/** 取 semver 的数值核心（去前导 v 与 prerelease）。 */
function semverCore(v: string): number[] {
  return (v.replace(/^v/, '').split('-')[0] ?? '').split('.').map(Number)
}

/** 语义化版本比较：a < b → -1，a == b → 0，a > b → 1。忽略前导 v 和 prerelease。 */
function compareSemver(a: string, b: string): number {
  const pa = semverCore(a)
  const pb = semverCore(b)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

/** 查询 npm registry 判断是否有新版本。网络/解析失败时返回 hasUpdate:false，绝不抛错。 */
async function checkForUpdate(opts: CheckOptions = {}): Promise<UpdateCheckResult> {
  const pkg = opts.packageName ?? DEFAULT_PACKAGE
  const current = opts.currentVersion ?? getCurrentVersion()
  const registry = opts.registryUrl ?? DEFAULT_REGISTRY
  const fetchImpl = opts.fetchImpl ?? fetch

  const result: UpdateCheckResult = {
    hasUpdate: false,
    currentVersion: current,
    latestVersion: current,
  }

  try {
    const res = await fetchImpl(`${registry}/${pkg}/latest`)
    if (!res.ok) return result
    const data = (await res.json()) as { version?: string }
    if (!data.version) return result
    result.latestVersion = data.version
    result.hasUpdate = compareSemver(current, data.version) < 0
  } catch {
    // 离线/网络错误：保守地报告无更新
  }
  return result
}

export type { CheckOptions, UpdateCheckResult }
export { checkForUpdate, compareSemver, getCurrentVersion }
