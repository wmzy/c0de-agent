import { lazy, Suspense } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary.js'
import { TopBar } from '@/components/TopBar.js'
import { centeredHint } from '@/views/_shared/errorState.js'
import { Layout } from '@/views/Layout.js'

// Settings 体积最大（含 6+ 子面板：JsonConfigEditor/MCPPanel/ModelPanel 等），
// 且仅在 /settings 路由访问时才需要，懒加载为独立 chunk 以降低首屏 bundle。
const Settings = lazy(() => import('@/views/Settings.js').then((m) => ({ default: m.Settings })))

/** 设置页（P1-1）：/settings 与 /projects/:projectId/settings 共用同一布局包装。 */
export function SettingsPage() {
  return (
    <Layout
      header={<TopBar />}
      main={
        <ErrorBoundary>
          <Suspense fallback={<div className={centeredHint}>加载中…</div>}>
            <Settings />
          </Suspense>
        </ErrorBoundary>
      }
    />
  )
}
