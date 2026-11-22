// Sharpshooter 存储层：目录布局、delta 队列、state 簿记、跨进程文件锁。
//
// 布局（全部在全局配置目录下，绝不写进项目工作树）：
//   <memoriesRoot>/sharpshooter/<bankId>/
//     architecture.md / product.md / style.md   — 三个决策文件
//     learned.md                                 — learn 工具的手动条目
//     queue/<sessionId>/<ts36>-<nonce>.json      — 一条 delta 一个文件
//     state.json                                 — 整合簿记
//     consolidate.lock / learn.lock              — 跨进程单写者锁
//
// file-per-delta 让生产者免锁：没有与消费方竞争的共享 append，apply 与 unlink
// 之间崩溃只会重投 delta（整合按「最新优先的整文件重写」天然幂等）。
// Bun 专属 API（Bun.write/Bun.hash）按仓库约定换 Node fs/promises 与 node:crypto。

import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { readJsonFileSafe } from '../shared/utils/json-file.js'
import type { SharpshooterDelta, SharpshooterState } from './types.js'

/** memories 根下的 sharpshooter 一级目录。 */
export function sharpshooterRoot(memoriesRoot: string): string {
  return join(memoriesRoot, 'sharpshooter')
}

/** 项目目录名（basename）清洗：非法字符折叠为 '-'，空前缘/尾缘剥除。 */
function sanitizeBankName(value: string | undefined): string | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return sanitized || undefined
}

/** bank 名长度上限 64：超出时截前缀 + 追加内容散列，保持稳定且可读。
 *  散列用 sha256/base64url（omp 用 Bun.hash；bank id 只在本机使用，算法无需对齐）。 */
function limitBankName(name: string): string {
  if (name.length <= 64) return name
  const hash = createHash('sha256').update(name).digest('base64url').slice(0, 10)
  const prefix = name.slice(0, 52).replace(/-+$/g, '') || 'bank'
  return `${prefix}-${hash}`
}

/** 从 cwd 单独派生的稳定 bank id（omp projectBankSegment 口径：basename + 路径散列）。
 *  resolve 归一化尾部斜杠/相对路径；相同目录名、不同路径的项目必须落在不同 bank。 */
export function projectBankSegment(cwd: string): string {
  const resolved = resolve(cwd || '.')
  const base = sanitizeBankName(basename(resolved)) ?? 'default'
  const hash = createHash('sha256').update(resolved).digest('base64url').slice(0, 10)
  return limitBankName(`${base}-${hash}`)
}

/** 某项目的 bank 目录。 */
export function bankDir(memoriesRoot: string, cwd: string): string {
  return join(sharpshooterRoot(memoriesRoot), projectBankSegment(cwd))
}

/** bank 内某个记忆文件路径。 */
export function memoryFilePath(memoriesRoot: string, cwd: string, file: string): string {
  return join(bankDir(memoriesRoot, cwd), file)
}

/** bank 的队列根；每会话一个子目录。 */
export function queueDir(memoriesRoot: string, cwd: string): string {
  return join(bankDir(memoriesRoot, cwd), 'queue')
}

/** 会话 id 作目录名：剥路径敌对字符。实践中是 UUID 形，此处是防御而非规范化。 */
export function sanitizeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'session'
}

/** ts36 补零使字典序 == 时间序；nonce 打散同毫秒并发写入。 */
function queueFileName(ts: number): string {
  const nonce = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  return `${ts.toString(36).padStart(10, '0')}-${nonce}.json`
}

/** 一条 delta 落入其会话的队列目录。 */
export async function appendDelta(
  memoriesRoot: string,
  cwd: string,
  delta: SharpshooterDelta,
): Promise<void> {
  const dir = join(queueDir(memoriesRoot, cwd), sanitizeSessionId(delta.sessionId))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, queueFileName(delta.ts)), JSON.stringify(delta), 'utf-8')
}

/** 一条已入队 delta 及其承载文件（消费令牌）。 */
export interface QueuedDelta {
  delta: SharpshooterDelta
  file: string
}

/** 一个会话的全部队列 delta，最旧在前。 */
export interface SharpshooterSessionDeltas {
  sessionId: string
  deltas: QueuedDelta[]
}

const SESSION_DIR_RE = /^[A-Za-z0-9_-]+$/

function isDeltaShape(parsed: unknown): parsed is SharpshooterDelta {
  if (!parsed || typeof parsed !== 'object') return false
  const d = parsed as Record<string, unknown>
  return d.v === 1 && typeof d.statement === 'string'
}

/** 列出全部队列 delta，按会话分组：会话按最旧 delta 排序，组内最旧在前。
 *  不可读/损坏条目跳过（不消费）——撕裂写不能把队列楔死。 */
export async function listDeltas(
  memoriesRoot: string,
  cwd: string,
): Promise<SharpshooterSessionDeltas[]> {
  const root = queueDir(memoriesRoot, cwd)
  let sessionDirs: string[]
  try {
    sessionDirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && SESSION_DIR_RE.test(entry.name))
      .map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const groups: SharpshooterSessionDeltas[] = []
  for (const sessionId of sessionDirs) {
    const dir = join(root, sessionId)
    const names = (await fs.readdir(dir).catch(() => [] as string[]))
      .filter((name) => name.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b))
    const deltas: QueuedDelta[] = []
    for (const name of names) {
      const file = join(dir, name)
      const parsed = readJsonFileSafe<SharpshooterDelta>(file)
      // 损坏/异质文件留给人工检查，绝不消费。
      if (parsed !== null && isDeltaShape(parsed)) deltas.push({ delta: parsed, file })
    }
    if (deltas.length > 0) groups.push({ sessionId, deltas })
  }
  groups.sort((a, b) => (a.deltas[0]?.delta.ts ?? 0) - (b.deltas[0]?.delta.ts ?? 0))
  return groups
}

/** 删除已消费的 delta 文件并清掉被掏空的会话目录。缺失文件忽略——并发消费方已赢。 */
export async function consumeDeltas(files: readonly string[]): Promise<void> {
  const dirs = new Set<string>()
  for (const file of files) {
    try {
      await fs.rm(file, { force: true })
    } catch {
      // 尽力而为：删不掉只会导致重投。
    }
    dirs.add(dirname(file))
  }
  for (const dir of dirs) {
    const remaining = await fs.readdir(dir).catch(() => null)
    if (remaining !== null && remaining.length === 0) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** 队列 delta 总数（状态展示用）。 */
export async function queueDepth(memoriesRoot: string, cwd: string): Promise<number> {
  const groups = await listDeltas(memoriesRoot, cwd)
  return groups.reduce((sum, group) => sum + group.deltas.length, 0)
}

/** 读 bank 的整合 state；缺失/损坏回退 epoch state（只是推迟下一次整合窗口）。 */
export function readState(memoriesRoot: string, cwd: string): SharpshooterState {
  const parsed = readJsonFileSafe<SharpshooterState>(join(bankDir(memoriesRoot, cwd), 'state.json'))
  if (parsed && typeof parsed === 'object' && parsed.v === 1) return parsed
  return { v: 1, lastConsolidatedAt: 0 }
}

/** 持久化 bank 的整合 state（父目录自动创建）。 */
export async function writeState(
  memoriesRoot: string,
  cwd: string,
  state: SharpshooterState,
): Promise<void> {
  const file = join(bankDir(memoriesRoot, cwd), 'state.json')
  await fs.mkdir(dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(state, null, '\t')}\n`, 'utf-8')
}

// ── 跨进程文件锁 ──────────────────────────────────────────────
// c0de 是单写者 server，锁主要防 CLI 与 server 同时写同一 bank：O_CREAT|O_EXCL
// 原子创建 + 过期检测（写者崩溃没释放时，超龄锁可被偷走）。锁是建议性的：
// 拿不到就返回 null 让调用方按「忙」语义跳过，绝不阻塞等待。

/** 锁文件超过此时长未释放视为写者已死，可被偷走（整合最长也就分钟级）。 */
const LOCK_STALE_MS = 10 * 60_000

export interface BankLock {
  /** 释放锁；锁已被偷走时不动别人的锁。 */
  release: () => Promise<void>
}

function lockPath(memoriesRoot: string, cwd: string, name: string): string {
  return join(bankDir(memoriesRoot, cwd), `${name}.lock`)
}

async function tryCreateLockFile(path: string, token: string): Promise<boolean> {
  try {
    const handle = await fs.open(path, 'wx')
    try {
      await handle.writeFile(token, 'utf-8')
    } finally {
      await handle.close()
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/** 获取 bank 级命名锁；忙/被占返回 null。 */
export async function acquireBankLock(
  memoriesRoot: string,
  cwd: string,
  name: string,
): Promise<BankLock | null> {
  const path = lockPath(memoriesRoot, cwd, name)
  await fs.mkdir(dirname(path), { recursive: true })
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  if (await tryCreateLockFile(path, token)) return releaseFor(path, token)
  // 已被占用：检查是否超龄（写者崩溃遗留），超龄则偷走重试一次。
  try {
    const stat = await fs.stat(path)
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      await fs.rm(path, { force: true })
      if (await tryCreateLockFile(path, token)) return releaseFor(path, token)
    }
  } catch {
    // stat/rm 失败（并发偷锁竞态）：按忙处理。
  }
  return null
}

function releaseFor(path: string, token: string): BankLock {
  let released = false
  return {
    async release(): Promise<void> {
      if (released) return
      released = true
      try {
        const current = await fs.readFile(path, 'utf-8').catch(() => null)
        // 只有内容仍是自己的 token 才删：锁被偷走后新持有者的锁不能误放。
        if (current === token) await fs.rm(path, { force: true })
      } catch {
        // 尽力而为：残留锁文件靠过期检测自愈。
      }
    },
  }
}
