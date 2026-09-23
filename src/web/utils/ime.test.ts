// IME 组合态判定（src/web/utils/ime.ts）。
//
// 组合中的回车/ESC 必须放行给输入法：不判定就会把未确认的候选当最终输入
// （表单提前提交、建议被选中、重命名被取消）。此文件锁住判定本身，
// 各输入组件的「组合中不触发动作」行为在组件测试里锁定。
import { describe, expect, it } from 'vitest'
import { isImeComposing } from '@/utils/ime.js'

describe('isImeComposing', () => {
  it('React 合成事件：nativeEvent.isComposing 为真时判定为组合中', () => {
    expect(isImeComposing({ nativeEvent: { isComposing: true, keyCode: 229 } })).toBe(true)
  })

  it('原生事件：isComposing 为真时判定为组合中', () => {
    expect(isImeComposing({ isComposing: true, keyCode: 229 })).toBe(true)
  })

  it('无 isComposing 但 keyCode 为 229（老 Safari 的 IME 标记）同样判定为组合中', () => {
    expect(isImeComposing({ keyCode: 229 })).toBe(true)
  })

  it('普通回车（keyCode 13、无组合）不判定为组合中', () => {
    expect(isImeComposing({ keyCode: 13 })).toBe(false)
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false)
    expect(isImeComposing({})).toBe(false)
  })
})
