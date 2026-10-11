// 输入框草稿持久化（按作用域：会话 / 草稿页的项目）。
//
// 此前草稿只活在 useComposer 的内存 ref 里：切会话时 ChatSession 会先渲染
// ChatSkeleton（Composer 整个卸载）、刷新整页更是重建组件——未发送的长提示词
// 与图片附件静默消失。提示历史也接不住它（历史只记已发送文本），用户只能凭
// 记忆重打。
//
// 存储口径与 composer-history.v1 一致：localStorage 经 utils/storage 单入口，
// 存储被禁/配额耗尽时静默降级为「本次会话内不持久化」。图片是 base64
// dataURL，6 张 8MB 上限的图远超 localStorage 配额（约 5MB）——整份写入失败会
// 连文本一起丢掉，故超预算时只存文本部分。

import { type ContentPart, type ImagePart, isPromptEmpty, type Prompt } from '@/composer/types.js'
import { storageGet, storageRemove, storageSet } from '@/utils/storage.js'

/** 草稿键前缀（带版本号：结构变更时旧键自然失效，无需迁移）。 */
const DRAFT_KEY_PREFIX = 'composer-draft.v1:'
/** 图片随草稿持久化的总预算（dataURL 字符数）。超预算只持久化文本。 */
const MAX_DRAFT_IMAGE_CHARS = 512 * 1024

type StoredDraft = { prompt: Prompt; images: ImagePart[] }

/** 作用域 → 存储键。作用域由调用方给出（`s:<sessionId>` / `p:<projectId>`）。 */
function draftStorageKey(scope: string): string {
  return `${DRAFT_KEY_PREFIX}${scope}`
}

/** 单个 part 的形状校验：storage 里的 JSON 不可信（旧版本结构、手改、半截写入），
 *  形状不对时整份草稿丢弃——半份 prompt 进编辑器比没有草稿更糟。 */
function isStoredPart(value: unknown): value is ContentPart {
  if (!value || typeof value !== 'object') return false
  const part = value as Record<string, unknown>
  if (typeof part.start !== 'number' || typeof part.end !== 'number') return false
  switch (part.type) {
    case 'text':
      return typeof part.content === 'string'
    case 'file':
      return typeof part.path === 'string' && typeof part.content === 'string'
    case 'snippet':
      return (
        typeof part.path === 'string' &&
        typeof part.lineStart === 'number' &&
        typeof part.lineEnd === 'number' &&
        typeof part.label === 'string' &&
        typeof part.snippet === 'string'
      )
    case 'terminal':
      return typeof part.label === 'string' && typeof part.content === 'string'
    default:
      return false
  }
}

function isStoredImage(value: unknown): value is ImagePart {
  if (!value || typeof value !== 'object') return false
  const image = value as Record<string, unknown>
  return (
    image.type === 'image' && typeof image.mediaType === 'string' && typeof image.data === 'string'
  )
}

/** 读取草稿；无草稿/存储不可用/结构损坏一律返回 null。 */
function loadDraft(scope: string): StoredDraft | null {
  const raw = storageGet(draftStorageKey(scope))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { prompt?: unknown; images?: unknown }
    if (!Array.isArray(parsed.prompt) || !parsed.prompt.every(isStoredPart)) return null
    const images = Array.isArray(parsed.images) ? parsed.images.filter(isStoredImage) : []
    return { prompt: parsed.prompt, images }
  } catch {
    return null
  }
}

/** 写入草稿。空草稿（无文本引用且无图片）删除键，避免无用条目长期堆积。 */
function saveDraft(scope: string, prompt: Prompt, images: ImagePart[]): void {
  if (isPromptEmpty(prompt) && images.length === 0) {
    storageRemove(draftStorageKey(scope))
    return
  }
  const key = draftStorageKey(scope)
  const imageChars = images.reduce((n, i) => n + i.data.length, 0)
  // 超预算：只存文本（图片是 base64，塞满配额会让整份写入失败、连文本一起丢）。
  const payload: StoredDraft =
    imageChars > MAX_DRAFT_IMAGE_CHARS ? { prompt, images: [] } : { prompt, images }
  storageSet(key, JSON.stringify(payload))
}

/** 清退某会话的草稿：会话被删除（purgeEmpty / 侧栏删除）后调用。
 *  发送失败的还原分支会把失败快照落回 s:<sessionId> 草稿键；会话本身没了，
 *  这份草稿再也无人读取（文本无上限、图片最多 ~512KB），不清退就永久滞留
 *  localStorage。 */
function clearSessionDraft(sessionId: string): void {
  storageRemove(draftStorageKey(`s:${sessionId}`))
}

export type { StoredDraft }
export {
  clearSessionDraft,
  DRAFT_KEY_PREFIX,
  draftStorageKey,
  loadDraft,
  MAX_DRAFT_IMAGE_CHARS,
  saveDraft,
}
