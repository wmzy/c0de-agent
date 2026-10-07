// failedSendReason 是跨页面传话的媒介：首条消息失败的会话被 purge 后跳回草稿页，
// 原因与载荷只能靠它带过去。锁住三件事：take 一次性消费（防刷新后重复弹出）、
// sessionStorage 镜像（同页签 React 重挂载不丢）、delete 可撤销。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { failedSendReason } from '@/hooks/failedSendReason.js'

const payload = { text: 'hi', prompt: [], images: [], files: [] }

afterEach(() => {
  failedSendReason.delete('p1')
  sessionStorage.clear()
})

describe('failedSendReason', () => {
  it('take 消费后再次读取为 null（一次性）', () => {
    failedSendReason.set('p1', { reason: '未配置 Provider', payload })
    expect(failedSendReason.take('p1')?.reason).toBe('未配置 Provider')
    expect(failedSendReason.take('p1')).toBeNull()
  })

  it('内存 Map 丢失（页面刷新）时从 sessionStorage 读回', async () => {
    // 必须重新加载模块才能真正模拟「刷新」：模块级 Map 在测试进程里一直活着，
    // 直接 set 的话 take 会命中内存项，sessionStorage 回退路径根本没被走到
    // （删掉 loadFromStorage 这条用例也照样通过）。
    vi.resetModules()
    const { failedSendReason: fresh } = await import('@/hooks/failedSendReason.js')
    sessionStorage.setItem(
      'c0de-agent:failedSend:p1',
      JSON.stringify({ reason: '连接中断', payload }),
    )
    expect(fresh.take('p1')?.reason).toBe('连接中断')
    // 一次性消费：镜像也被清掉
    expect(fresh.take('p1')).toBeNull()
    expect(sessionStorage.getItem('c0de-agent:failedSend:p1')).toBeNull()
  })

  it('payload 原样带回（文本与文件引用）', () => {
    failedSendReason.set('p1', {
      reason: 'x',
      payload: { text: '带引用的消息', prompt: [], images: [], files: ['src/a.ts'] },
    })
    expect(failedSendReason.take('p1')?.payload.files).toEqual(['src/a.ts'])
  })
})
