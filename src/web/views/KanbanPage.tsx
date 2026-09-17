import { useMatched } from '@native-router/react'
import { TopBar } from '@/components/TopBar.js'
import { KanbanView } from '@/views/KanbanView.js'
import { Layout } from '@/views/Layout.js'
import { NotFound } from '@/views/NotFound.js'

/**
 * 项目看板页：展示项目级共享看板，支持拖拽、卡片编辑、列/标签配置。
 */
export function KanbanPage() {
  const { params } = useMatched()
  const projectId = params.projectId
  if (!projectId) return <Layout header={<TopBar />} main={<NotFound />} />

  return <Layout header={<TopBar />} main={<KanbanView projectId={projectId} />} />
}
