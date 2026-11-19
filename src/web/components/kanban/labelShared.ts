// 看板标签域的共享实现：BoardConfigDialog（标签管理行）与 CardEditDialog
// （卡片内创建标签行）此前各持一份拷贝——调色板、色板控件尺寸（22/24px 已漂移）、
// 「输入名 → 新标签草稿」的构造逻辑完全同构，收敛到这里单点维护。
import { css } from '@linaria/core'
import { KANBAN_LABEL_COLORS } from '@shared/types/kanban.js'
import { generateId } from '@/hooks/id.js'
import type { KanbanLabelDef } from '@/services/kanban.js'

/** 新建标签行的默认选中色。候选色调色板的正典在 shared/types/kanban.ts 的
 *  KANBAN_LABEL_COLORS（看板域共享定义），web 侧不持副本——本地副本漂移会
 *  造出正典之外的默认色值。 */
export const DEFAULT_LABEL_COLOR: string = KANBAN_LABEL_COLORS[0] ?? '#ef4444'

/** 色板控件（SyncedInput type=color 的 className）：统一 24px（CardEditDialog
 *  此前漂移为 22px，另一处（BoardConfigDialog）已是 24px）。 */
export const colorSwatch = css`
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: 1px solid var(--haze-color-border);
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
  background: none;
`

/** 由「新建标签」输入构造标签草稿：名字去空白；空名不是合法标签，返回 null。
 *  两个弹窗各自保留自己的 state 更新（CardEditDialog 还要把新标签选上本卡片）。 */
export function createLabelDraft(name: string, color: string): KanbanLabelDef | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  return { id: generateId(), name: trimmed, color }
}
