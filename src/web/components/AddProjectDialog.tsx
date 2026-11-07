import { DirectoryProjectDialog } from '@/components/DirectoryProjectDialog.js'
import { projectAPI } from '@/services/project.js'
import type { Project } from '@/types/index.js'

type AddProjectDialogProps = {
  onClose: () => void
  /** 创建成功回调（通常用于切换到新项目）。 */
  onCreated?: (project: Project) => void
}

/** 「添加项目」弹窗：输入目录路径，解析并创建项目记录。 */
export function AddProjectDialog({ onClose, onCreated }: AddProjectDialogProps) {
  return (
    <DirectoryProjectDialog
      title="添加项目"
      hint="输入目录名可递归搜索深层目录，或在文件树中浏览选择。"
      placeholder="/path/to/your/project"
      testId="add-project"
      pendingLabel="创建中…"
      confirmLabel="添加"
      mutationFn={(dir) => projectAPI.fromDirectory(dir)}
      invalidations={[
        // 刷新项目列表 + 当前项目指示器
        ['projects'],
        ['project', 'current'],
      ]}
      onSuccess={(project) => onCreated?.(project)}
      onClose={onClose}
    />
  )
}

export type { AddProjectDialogProps }
