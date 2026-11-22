import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireBankLock,
  appendDelta,
  bankDir,
  consumeDeltas,
  listDeltas,
  projectBankSegment,
  queueDepth,
  readState,
  sanitizeSessionId,
  writeState,
} from './storage.js'
import type { SharpshooterDelta } from './types.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memory-storage-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function delta(overrides: Partial<SharpshooterDelta> = {}): SharpshooterDelta {
  return {
    v: 1,
    kind: 'constraint',
    statement: 'Never store secrets in memory files',
    source: 'explicit_user',
    evidence: 'never store secrets',
    friction: { corrective: false, regression: false, subtle: true },
    sessionId: 'session-1',
    ts: 1_000,
    ...overrides,
  }
}

describe('projectBankSegment', () => {
  it('同一 cwd 稳定，不同 cwd（同名目录）隔离', () => {
    const a1 = projectBankSegment('/home/x/projects/app')
    const a2 = projectBankSegment('/home/x/projects/app/')
    const b = projectBankSegment('/home/y/projects/app')
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(a1).toMatch(/^app-/)
  })

  it('敌对字符与超长目录名被折叠/截断', () => {
    const hostile = projectBankSegment('/tmp/..%..::bad name')
    expect(hostile).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(hostile.length).toBeLessThanOrEqual(64)
    const long = projectBankSegment(`/tmp/${'a'.repeat(200)}`)
    expect(long.length).toBeLessThanOrEqual(64)
  })
})

describe('queue', () => {
  it('bankId 隔离：不同 cwd 的 delta 互不可见', async () => {
    await appendDelta(root, '/proj/a', delta({ sessionId: 's1' }))
    await appendDelta(root, '/proj/b', delta({ sessionId: 's1' }))
    expect(await queueDepth(root, '/proj/a')).toBe(1)
    expect(await queueDepth(root, '/proj/b')).toBe(1)
    expect(bankDir(root, '/proj/a')).not.toBe(bankDir(root, '/proj/b'))
  })

  it('按会话分组、组内按时间排序、会话按最旧 delta 排序', async () => {
    await appendDelta(root, '/proj', delta({ sessionId: 'late', ts: 5_000 }))
    await appendDelta(root, '/proj', delta({ sessionId: 'late', ts: 4_000 }))
    await appendDelta(root, '/proj', delta({ sessionId: 'early', ts: 1_000 }))
    const groups = await listDeltas(root, '/proj')
    expect(groups.map((g) => g.sessionId)).toEqual(['early', 'late'])
    expect(groups[1]?.deltas.map((d) => d.delta.ts)).toEqual([4_000, 5_000])
  })

  it('损坏/异质文件跳过且不消费；非法会话目录忽略', async () => {
    const dir = join(bankDir(root, '/proj'), 'queue')
    mkdirSync(join(dir, 'ok-session'), { recursive: true })
    writeFileSync(join(dir, 'ok-session', '00000001-aaaa.json'), JSON.stringify(delta({ ts: 1 })))
    writeFileSync(join(dir, 'ok-session', '00000002-bbbb.json'), '{torn')
    mkdirSync(join(dir, '.hidden'), { recursive: true })
    writeFileSync(join(dir, '.hidden', 'x.json'), JSON.stringify(delta()))
    const groups = await listDeltas(root, '/proj')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.deltas).toHaveLength(1)
    // 损坏文件仍在（留给人工检查），消费只删合法那枚。
    await consumeDeltas([join(dir, 'ok-session', '00000001-aaaa.json')])
    const rest = await listDeltas(root, '/proj')
    expect(rest).toHaveLength(0)
    const { readdirSync, existsSync } = await import('node:fs')
    expect(existsSync(join(dir, 'ok-session', '00000002-bbbb.json'))).toBe(true)
    // 会话目录掏空后被清掉。
    expect(readdirSync(join(dir, 'ok-session'))).toHaveLength(1)
  })

  it('sanitizeSessionId 剥路径敌对字符并兜底空串', () => {
    // 连续非法字符折叠为单个 '-'（与 omp 口径一致）。
    expect(sanitizeSessionId('abc/../../etc')).toBe('abc-etc')
    expect(sanitizeSessionId('---')).toBe('session')
    expect(sanitizeSessionId('uuid-123_ABC')).toBe('uuid-123_ABC')
  })
})

describe('state', () => {
  it('缺失回退 epoch；写入后可读回', async () => {
    expect(readState(root, '/proj')).toEqual({ v: 1, lastConsolidatedAt: 0 })
    await writeState(root, '/proj', { v: 1, lastConsolidatedAt: 42 })
    expect(readState(root, '/proj').lastConsolidatedAt).toBe(42)
    // 损坏 state 回退 epoch。
    writeFileSync(join(bankDir(root, '/proj'), 'state.json'), 'nope')
    expect(readState(root, '/proj')).toEqual({ v: 1, lastConsolidatedAt: 0 })
  })
})

describe('bank lock', () => {
  it('互斥：持锁期间第二次获取为 null，释放后可再获取', async () => {
    const first = await acquireBankLock(root, '/proj', 'consolidate')
    expect(first).not.toBeNull()
    const second = await acquireBankLock(root, '/proj', 'consolidate')
    expect(second).toBeNull()
    await first?.release()
    const third = await acquireBankLock(root, '/proj', 'consolidate')
    expect(third).not.toBeNull()
    await third?.release()
  })

  it('不同名锁互不干扰；超龄锁可被偷走', async () => {
    const learn = await acquireBankLock(root, '/proj', 'learn')
    expect(learn).not.toBeNull()
    // consolidate 锁与 learn 锁是两个文件。
    const consolidate = await acquireBankLock(root, '/proj', 'consolidate')
    expect(consolidate).not.toBeNull()
    await learn?.release()
    await consolidate?.release()

    // 手工放置 11 分钟前的超龄锁文件（写者崩溃遗留）→ 可被偷走。
    const stalePath = join(bankDir(root, '/proj'), 'consolidate.lock')
    writeFileSync(stalePath, 'dead-pid')
    const old = new Date(Date.now() - 11 * 60_000)
    utimesSync(stalePath, old, old)
    const stolen = await acquireBankLock(root, '/proj', 'consolidate')
    expect(stolen).not.toBeNull()
    await stolen?.release()
  })
})
