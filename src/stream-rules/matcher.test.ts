import { describe, expect, it } from 'vitest'
import {
  createStreamRuleChecker,
  renderStreamRuleInjection,
  STREAM_BUFFER_LIMIT,
} from './matcher.js'
import type { StreamRule } from './types.js'

const makeRule = (overrides: Partial<StreamRule> = {}): StreamRule => ({
  name: 'no-foo',
  conditions: [/foo/],
  scope: 'text',
  repeatMode: 'once',
  repeatGap: 10,
  body: '不要输出 foo。',
  source: '/rules/no-foo.md',
  ...overrides,
})

describe('createStreamRuleChecker', () => {
  it('命中返回 ruleName 与渲染好的 injection', () => {
    const checker = createStreamRuleChecker([makeRule()])
    expect(checker.checkTextDelta('普通文本')).toBeNull()
    expect(checker.checkTextDelta('这里出现了 foo 字样')).toEqual({
      ruleName: 'no-foo',
      injection: '<stream-rule name="no-foo">\n不要输出 foo。\n</stream-rule>',
    })
  })

  it('增量缓冲拼接：跨 delta 的匹配能命中', () => {
    const checker = createStreamRuleChecker([makeRule({ conditions: [/TODO\(fix\)/] })])
    expect(checker.checkTextDelta('代码里有 TO')).toBeNull()
    expect(checker.checkTextDelta('DO(f')).toBeNull()
    expect(checker.checkTextDelta('ix) 标记')).not.toBeNull()
  })

  it('多规则同时命中：规则表顺序（首个命中）优先', () => {
    const first = makeRule({ name: 'first', conditions: [/aaa/] })
    const second = makeRule({ name: 'second', conditions: [/bbb/] })
    expect(createStreamRuleChecker([first, second]).checkTextDelta('aaabbb')?.ruleName).toBe(
      'first',
    )
    expect(createStreamRuleChecker([second, first]).checkTextDelta('aaabbb')?.ruleName).toBe(
      'second',
    )
  })

  it('repeat once：本进程至多触发一次，其他规则不受影响', () => {
    const once = makeRule({ name: 'once-rule', conditions: [/foo/] })
    const other = makeRule({ name: 'other-rule', conditions: [/bar/] })
    const checker = createStreamRuleChecker([once, other])

    expect(checker.checkTextDelta('foo')?.ruleName).toBe('once-rule')
    checker.resetStream()
    expect(checker.checkTextDelta('foo')).toBeNull()
    expect(checker.checkTextDelta('bar')?.ruleName).toBe('other-rule')
  })

  it('repeat turn-gap：不足 gap 的命中被吞且刷新 lastHit（持续违规不放宽 gap）', () => {
    const rule = makeRule({
      name: 'gap-rule',
      conditions: [/bad/],
      repeatMode: 'turn-gap',
      repeatGap: 2,
    })
    const checker = createStreamRuleChecker([rule])

    // 流 0：首次命中并上报
    expect(checker.checkTextDelta('bad')?.ruleName).toBe('gap-rule')
    // 流 1：1-0=1 < gap，命中被吞——但 lastHit 刷新为 1
    checker.resetStream()
    expect(checker.checkTextDelta('bad')).toBeNull()
    // 流 2：若被吞的命中不刷新 lastHit，2-0=2 将命中；刷新后 2-1=1 仍吞
    checker.resetStream()
    expect(checker.checkTextDelta('bad')).toBeNull()
    // 流 3：干净流（无命中）不改变 lastHit=2
    checker.resetStream()
    expect(checker.checkTextDelta('ok')).toBeNull()
    // 流 4：4-2=2 ≥ gap，重新可触发
    checker.resetStream()
    expect(checker.checkTextDelta('bad')?.ruleName).toBe('gap-rule')
  })

  it('repeat always：每个新流都可再触发，但同流内只上报一次', () => {
    const checker = createStreamRuleChecker([makeRule({ repeatMode: 'always' })])

    expect(checker.checkTextDelta('foo')).not.toBeNull()
    // 同流内防御性重复调用不再上报（loop 命中即断流）
    expect(checker.checkTextDelta('更多 foo')).toBeNull()
    checker.resetStream()
    expect(checker.checkTextDelta('foo')).not.toBeNull()
  })

  it('滚动窗口：被逐出窗口的旧文本不再参与匹配', () => {
    const rule = makeRule({ conditions: [/ANCIENT[\s\S]*MARKER/] })
    // 对照：ANCIENT 与 MARKER 都在窗口内 → 命中
    const control = createStreamRuleChecker([rule])
    control.checkTextDelta('ANCIENT')
    expect(control.checkTextDelta(`${' filler '.repeat(10)}MARKER`)).not.toBeNull()

    // ANCIENT 被超出窗口上限的 filler 逐出后，MARKER 无法再与之配对
    const evicted = createStreamRuleChecker([rule])
    evicted.checkTextDelta('ANCIENT')
    expect(evicted.checkTextDelta('x'.repeat(STREAM_BUFFER_LIMIT))).toBeNull()
    expect(evicted.checkTextDelta('MARKER')).toBeNull()
  })

  it('resetStream 清空缓冲：上一流的残留不再参与拼接', () => {
    const checker = createStreamRuleChecker([makeRule({ conditions: [/foobar/] })])
    checker.checkTextDelta('fo')
    checker.resetStream()
    expect(checker.checkTextDelta('obar')).toBeNull()
  })

  it('空 delta 与空规则表安全返回 null', () => {
    expect(createStreamRuleChecker([]).checkTextDelta('foo')).toBeNull()
    const checker = createStreamRuleChecker([makeRule()])
    expect(checker.checkTextDelta('')).toBeNull()
  })

  it('命中后缓冲保留（未 reset 时后续命中仅受门控与同流上报约束）', () => {
    // 同流已上报 → null；reset 后 once 规则也已在进程内耗尽
    const checker = createStreamRuleChecker([makeRule()])
    expect(checker.checkTextDelta('foo')).not.toBeNull()
    expect(checker.checkTextDelta('foo')).toBeNull()
    checker.resetStream()
    expect(checker.checkTextDelta('foo')).toBeNull()
  })
})

describe('renderStreamRuleInjection', () => {
  it('多行 body 原样保留在标签内', () => {
    expect(
      renderStreamRuleInjection(makeRule({ name: 'multi', body: '第一行指引\n第二行指引' })),
    ).toBe('<stream-rule name="multi">\n第一行指引\n第二行指引\n</stream-rule>')
  })

  it('空 body 仍渲染完整标签结构', () => {
    expect(renderStreamRuleInjection(makeRule({ name: 'empty', body: '' }))).toBe(
      '<stream-rule name="empty">\n\n</stream-rule>',
    )
  })
})
