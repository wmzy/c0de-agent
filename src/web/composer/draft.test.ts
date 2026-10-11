// clearSessionDraft 的清退语义：会话被删除（purgeEmpty / 侧栏删除）后，其草稿键
// 不得滞留 localStorage——发送失败的还原分支会把失败快照落回 s:<sessionId>
// （文本无上限、图片最多 ~512KB），会话没了就再无人读取。
import { describe, expect, it } from 'vitest'
import { clearSessionDraft, draftStorageKey, saveDraft } from '@/composer/draft.js'
import type { Prompt } from '@/composer/types.js'
import { storageGet, storageSet } from '@/utils/storage.js'

const textPrompt = (content: string): Prompt => [{ type: 'text', content, start: 0, end: 0 }]

describe('clearSessionDraft', () => {
  it('删除指定会话的草稿键，不动其他作用域', () => {
    saveDraft('s:s1', textPrompt('失败快照'), [])
    saveDraft('s:s2', textPrompt('别的会话的草稿'), [])
    storageSet(draftStorageKey('p:p1'), '{}')

    clearSessionDraft('s1')

    expect(storageGet(draftStorageKey('s:s1'))).toBeNull()
    // 会话前缀之外的作用域（另一会话 / 项目草稿页）不受影响
    expect(storageGet(draftStorageKey('s:s2'))).not.toBeNull()
    expect(storageGet(draftStorageKey('p:p1'))).not.toBeNull()
  })

  it('无草稿时清退是 no-op，不抛错', () => {
    expect(() => clearSessionDraft('never-existed')).not.toThrow()
    expect(storageGet(draftStorageKey('s:never-existed'))).toBeNull()
  })
})
