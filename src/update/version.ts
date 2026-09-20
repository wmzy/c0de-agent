import { readFileSync } from 'node:fs'

// 版本检查（spec §18.1）：查询 npm registry 比对当前版本。

type UpdateCheckResult = {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  releaseNotes?: string
  /** P3-8：检查本身失败（网络/registry 异常），与「已是最新」区分——
   *  消费方据此给出「稍后重试」而非误导性的「无更新」。 */
  checkError?: boolean
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

/** 解析 semver：core（X.Y.Z 数值数组）+ prerelease 标识符数组。
 *  前导 v 与 build metadata（+ 后缀）剥离；core 非「三个十进制非负整数」返回 null。
 *  此前只取 split('-')[0]：prerelease 被静默丢弃（beta 与正式版判相等、beta 间
 *  不分先后），且 '1.2.3+build' 的 patch 位解析为 NaN——NaN 参与比较恒返回 0，
 *  带 build metadata 的版本与任何版本判相等、永不提示更新。 */
function parseSemver(v: string): { core: number[]; prerelease: string[] } | null {
  const cleaned = v.trim().replace(/^v/, '')
  const noBuild = cleaned.replace(/\+.*$/, '')
  const dash = noBuild.indexOf('-')
  const coreStr = dash === -1 ? noBuild : noBuild.slice(0, dash)
  const coreParts = coreStr.split('.')
  if (coreParts.length !== 3 || coreParts.some((p) => !/^\d+$/.test(p))) return null
  return {
    core: coreParts.map(Number),
    prerelease: dash === -1 ? [] : noBuild.slice(dash + 1).split('.'),
  }
}

/**
 * 比较 prerelease 标识符（semver §11 优先级规则）：
 * 数字标识符按数值、非数字按字典序，数字恒小于非数字；更短前缀为更小。
 */
function comparePrerelease(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x) ? Number(x) : null
    const yNum = /^\d+$/.test(y) ? Number(y) : null
    if (xNum !== null && yNum !== null) {
      if (xNum !== yNum) return xNum < yNum ? -1 : 1
    } else if (xNum !== null) {
      return -1
    } else if (yNum !== null) {
      return 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** 语义化版本比较：a < b → -1，a == b → 0，a > b → 1。
 *  前导 v 与 build metadata 忽略；prerelease 低于同 core 的正式版。
 *  无法解析的版本保守返回 0（不误报更新）。 */
function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    const x = pa.core[i] ?? 0
    const y = pb.core[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0
  if (pa.prerelease.length === 0) return 1
  if (pb.prerelease.length === 0) return -1
  return comparePrerelease(pa.prerelease, pb.prerelease)
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
    if (!res.ok) {
      // 非 200（404/5xx/限流）→ 检查失败而非无更新
      result.checkError = true
      return result
    }
    const data = (await res.json()) as { version?: string }
    if (!data.version) {
      result.checkError = true
      return result
    }
    result.latestVersion = data.version
    result.hasUpdate = compareSemver(current, data.version) < 0
  } catch {
    // 离线/网络错误：保守地报告无更新，但标记检查失败供上层区分提示
    result.checkError = true
  }
  return result
}

export type { CheckOptions, UpdateCheckResult }
export { checkForUpdate, compareSemver, getCurrentVersion }
