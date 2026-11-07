import { DirectoryProjectDialog } from '@/components/DirectoryProjectDialog.js'
import { projectAPI } from '@/services/project.js'
import type { Project } from '@/types/index.js'

type RelocateProjectDialogProps = {
  /** 待重新定位的项目（worktree 已失效）。 */
  project: Project
  onClose: () => void
  /** 迁移成功回调（项目身份已更换为新目录，通常需导航到新 id）。 */
  onRelocated?: (project: Project) => void
}

/**
 * A1：「重新定位项目」弹窗——目录被移动/重命名后的恢复通道。
 * 输入新目录路径，后端把会话与看板整体迁移到新目录身份（替代删除项目）。
 */
export function RelocateProjectDialog({
  project,
  onClose,
  onRelocated,
}: RelocateProjectDialogProps) {
  return (
    <DirectoryProjectDialog
      title="重新定位项目"
      hint="项目目录已失效（被移动或重命名）。输入新目录路径后，会话与看板将整体迁移到新位置——无需删除项目，看板不会丢失。"
      placeholder="/new/path/to/project"
      testId="relocate-project"
      pendingLabel="迁移中…"
      confirmLabel="重新定位"
      mutationFn={(dir) => projectAPI.relocate(project.id, dir)}
      invalidations={[
        // 会话与看板随目录身份整体迁移，会话列表缓存一并失效
        ['projects'],
        ['project', 'current'],
        ['sessions'],
        ['sessions', 'tree'],
      ]}
      onSuccess={(res) => onRelocated?.(res.project)}
      onClose={onClose}
    />
  )
}
