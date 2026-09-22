import type { Session } from '@shared/types/message.js'
import { describe, expect, it } from 'vitest'
import { buildDeletedTreeIndex, countDeletedDescendants } from '@/views/_shared/recycleTree.js'

/** 最小 Session 构造（只用到 id/parentId）。 */
function s(id: string, parentId: string | null = null): Session {
  return {
    id,
    title: id,
    parentId,
    projectId: null,
    branchPoint: null,
    metadata: {},
    agentType: null,
    worktreePath: null,
    source: null,
    deletedAt: Date.now(),
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('countDeletedDescendants', () => {
  const count = (list: Session[], id: string) =>
    countDeletedDescendants(buildDeletedTreeIndex(list), id)

  it('统计任意深度的后代（不含起点自身）', () => {
    const list = [s('root'), s('a', 'root'), s('b', 'root'), s('c', 'a')]
    expect(count(list, 'root')).toBe(3)
    expect(count(list, 'a')).toBe(1)
    expect(count(list, 'c')).toBe(0)
  })

  it('无父会话与列表外 id 返回 0', () => {
    const list = [s('root'), s('a', 'root')]
    expect(count(list, 'missing')).toBe(0)
    expect(count([], 'root')).toBe(0)
  })

  // 复现：parentId 成环（a↔b 互指）时朴素栈遍历在环上无限打转——本函数在
  // RecycleBin 渲染期按行调用，死循环即标签页冻结。环上节点各计一次后终止。
  it('环数据（互指/自引用）不进入死循环', () => {
    const mutual = [s('a', 'b'), s('b', 'a')]
    expect(count(mutual, 'a')).toBe(1)

    const selfRef = [s('self', 'self')]
    expect(count(selfRef, 'self')).toBe(0)

    // 环挂在正常子树下：环上节点只计一次，子树其余后代照常计数
    const withCycle = [s('root'), s('x', 'root'), s('y', 'x'), s('x2', 'y'), s('y2', 'x2')]
    // root → x → y → x2 → y2 → x2(已访问，终止)
    expect(count(withCycle, 'root')).toBe(4)
  })
})
