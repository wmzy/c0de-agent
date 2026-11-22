import { describe, expect, it } from 'vitest'
import {
  ADVISOR_DEFAULT_BUDGET_PER_UPDATE,
  AdvisorEmissionGuard,
  normalizeAdvisorNote,
} from './emission-guard.js'
import type { AdvisorSeverity } from './types.js'

/** 便捷：准入判定（accepted 只看布尔）。 */
function admitted(guard: AdvisorEmissionGuard, note: string, severity: AdvisorSeverity = 'nit') {
  return guard.admit(note, severity).accepted
}

describe('normalizeAdvisorNote', () => {
  it('大小写/标点变体归一到同一 key', () => {
    expect(normalizeAdvisorNote('Stop.')).toBe('stop')
    expect(normalizeAdvisorNote('*Stop*')).toBe('stop')
    expect(normalizeAdvisorNote('  STOP  ')).toBe('stop')
    expect(normalizeAdvisorNote('No issue; continue.')).toBe('no issue continue')
  })

  it('CJK 字符保留在 key 中（中文 note 去重不失效）', () => {
    expect(normalizeAdvisorNote('注意：缺少 await！')).toBe('注意 缺少 await')
    expect(normalizeAdvisorNote('注意：缺少 await！')).toBe(normalizeAdvisorNote('注意 缺少 await'))
  })
})

describe('噪声过滤', () => {
  it('空泛赞美/自言自语被拒', () => {
    const guard = new AdvisorEmissionGuard()
    for (const noise of [
      'Looks good.',
      'no issues',
      'Continue as planned!',
      'OK',
      'LGTM',
      'Stop.',
    ]) {
      expect(guard.admit(noise, 'nit')).toEqual({ accepted: false, reason: 'noise' })
      // blocker 也不例外：噪声就是噪声（omp #3520 的 114×「Stop.」教训）
      expect(guard.admit(noise, 'blocker').accepted).toBe(false)
    }
  })

  it('空白 note 按 empty 拒绝', () => {
    const guard = new AdvisorEmissionGuard()
    expect(guard.admit('   ', 'concern')).toEqual({ accepted: false, reason: 'empty' })
  })

  it('具体的实质性 note 放行', () => {
    const guard = new AdvisorEmissionGuard()
    expect(
      admitted(
        guard,
        "Stop: 'await' missing on writeStream.end() will lose buffered writes.",
        'blocker',
      ),
    ).toBe(true)
  })
})

describe('rank-aware 去重', () => {
  it('同文本同级/降级重发被拒，严格升级放行', () => {
    const guard = new AdvisorEmissionGuard()
    expect(admitted(guard, 'check the error handling in upload.ts', 'nit')).toBe(true)
    expect(guard.admit('check the error handling in upload.ts', 'nit').reason).toBe('duplicate')
    expect(guard.admit('Check the error handling in upload.ts!', 'nit').reason).toBe('duplicate')
    // 升级 = 真实重申（concern/blocker 压过同义 nit）
    expect(admitted(guard, 'check the error handling in upload.ts', 'concern')).toBe(true)
    expect(admitted(guard, 'check the error handling in upload.ts', 'blocker')).toBe(true)
    // 升到 blocker 后同级重发仍是重复
    expect(guard.admit('check the error handling in upload.ts', 'blocker').reason).toBe('duplicate')
  })

  it('不同文本互不去重', () => {
    const guard = new AdvisorEmissionGuard()
    expect(admitted(guard, 'issue one', 'nit')).toBe(true)
    expect(admitted(guard, 'issue two', 'nit')).toBe(true)
  })

  it('去重历史上限触发 FIFO 淘汰：老 key 淘汰后可重新准入', () => {
    const guard = new AdvisorEmissionGuard({ capacity: 1 })
    expect(admitted(guard, 'first note', 'nit')).toBe(true)
    expect(admitted(guard, 'second note', 'nit')).toBe(true) // first 被淘汰
    expect(admitted(guard, 'first note', 'nit')).toBe(true) // 重新追踪
  })
})

describe('每 update 预算', () => {
  it(`缺省预算 ${ADVISOR_DEFAULT_BUDGET_PER_UPDATE}：超出限流`, () => {
    const guard = new AdvisorEmissionGuard()
    guard.beginUpdate()
    for (let i = 1; i <= 4; i++) {
      expect(admitted(guard, `distinct note ${i}`, 'nit')).toBe(true)
    }
    expect(guard.admit('distinct note 5', 'nit')).toEqual({ accepted: false, reason: 'rate-limit' })
  })

  it('blocker 豁免预算', () => {
    const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 })
    guard.beginUpdate()
    expect(admitted(guard, 'a nit', 'nit')).toBe(true)
    expect(guard.admit('another nit', 'nit').reason).toBe('rate-limit')
    expect(admitted(guard, 'a real blocker', 'blocker')).toBe(true)
    expect(admitted(guard, 'another blocker', 'blocker')).toBe(true)
  })

  it('被拒的调用不消耗预算', () => {
    const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 })
    guard.beginUpdate()
    expect(guard.admit('looks good', 'nit').reason).toBe('noise')
    expect(admitted(guard, 'real concern', 'concern')).toBe(true)
  })

  it('beginUpdate 重置预算槽', () => {
    const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 })
    guard.beginUpdate()
    expect(admitted(guard, 'note one', 'nit')).toBe(true)
    expect(guard.admit('note two', 'nit').reason).toBe('rate-limit')
    guard.beginUpdate()
    expect(admitted(guard, 'note two', 'nit')).toBe(true)
  })

  it('同 update 内升级复用槽位（改等级不占新槽）', () => {
    const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 })
    guard.beginUpdate()
    expect(admitted(guard, 'escalating note', 'nit')).toBe(true)
    expect(admitted(guard, 'escalating note', 'concern')).toBe(true) // 升级复用原槽
    // nit 的槽仍被同文本占用，新 note 只能被限流
    expect(guard.admit('fresh note', 'nit').reason).toBe('rate-limit')
  })

  it('blocker 升级释放同文本此前的非 blocker 槽', () => {
    const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 })
    guard.beginUpdate()
    expect(admitted(guard, 'doomed path', 'nit')).toBe(true) // 占满唯一槽
    expect(admitted(guard, 'doomed path', 'blocker')).toBe(true) // 升级并释放槽
    expect(admitted(guard, 'unrelated nit', 'nit')).toBe(true) // 槽已释放
  })
})

describe('blocker 冷却（immuneTurns）', () => {
  it('blocker 后 N 个 update 内非 blocker 被冷却拒绝，blocker 照常', () => {
    const guard = new AdvisorEmissionGuard({ immuneTurns: 3 })
    guard.beginUpdate() // update 1：blocker 打断
    expect(admitted(guard, 'hard stop', 'blocker')).toBe(true)
    guard.beginUpdate() // update 2：窗口 [2,4] 冷却
    expect(guard.admit('fresh nit during cooldown', 'nit').reason).toBe('cooldown')
    expect(guard.admit('fresh concern during cooldown', 'concern').reason).toBe('cooldown')
    expect(admitted(guard, 'another blocker', 'blocker')).toBe(true) // 豁免，且重置窗口起点为 2
    guard.beginUpdate() // update 3：新窗口 [3,5]
    expect(guard.admit('still cooling nit', 'nit').reason).toBe('cooldown')
    guard.beginUpdate() // update 4
    expect(guard.admit('fourth update nit', 'nit').reason).toBe('cooldown')
    guard.beginUpdate() // update 5
    expect(guard.admit('fifth update nit', 'nit').reason).toBe('cooldown')
    guard.beginUpdate() // update 6：窗口结束
    expect(admitted(guard, 'window over nit', 'nit')).toBe(true)
  })

  it('blocker 同 update 的随行非 blocker 不受冷却影响', () => {
    const guard = new AdvisorEmissionGuard({ immuneTurns: 3 })
    guard.beginUpdate()
    expect(admitted(guard, 'batch blocker', 'blocker')).toBe(true)
    // 同批 note 与 blocker 一起注入是正常组合（停 X + 顺带指出 Y）
    expect(admitted(guard, 'same batch nit', 'nit')).toBe(true)
    guard.beginUpdate()
    expect(guard.admit('next update nit', 'nit').reason).toBe('cooldown')
  })

  it('冷却拒绝不记录去重：窗口结束后同文本重发可准入', () => {
    const guard = new AdvisorEmissionGuard({ immuneTurns: 1 })
    guard.beginUpdate()
    expect(admitted(guard, 'blocker one', 'blocker')).toBe(true)
    guard.beginUpdate()
    expect(guard.admit('deferred nit', 'nit').reason).toBe('cooldown')
    guard.beginUpdate() // 窗口结束
    expect(admitted(guard, 'deferred nit', 'nit')).toBe(true)
  })

  it('immuneTurns 0 = 关闭冷却', () => {
    const guard = new AdvisorEmissionGuard({ immuneTurns: 0 })
    guard.beginUpdate()
    expect(admitted(guard, 'blocker zero', 'blocker')).toBe(true)
    guard.beginUpdate()
    expect(admitted(guard, 'immediate nit', 'nit')).toBe(true)
  })
})

describe('reset', () => {
  it('清空去重/预算/冷却状态', () => {
    const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1, immuneTurns: 3 })
    guard.beginUpdate()
    expect(admitted(guard, 'some note', 'nit')).toBe(true)
    expect(admitted(guard, 'a blocker', 'blocker')).toBe(true)
    guard.reset()
    guard.beginUpdate() // reset 后从第 1 个 update 重新计数，无冷却窗口
    expect(admitted(guard, 'some note', 'nit')).toBe(true)
    guard.beginUpdate() // 预算槽也已清空，跨 update 不残留
    expect(admitted(guard, 'post-reset nit', 'nit')).toBe(true)
  })
})
