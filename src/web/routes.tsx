import type { RoutePaths } from '@native-router/react'
import { createRoutes } from '@native-router/react'

/**
 * 应用路由表（native-router 单一事实源）。
 * satisfies 语义：表按 Route 检查，path 保留字面量类型——`as Route` 会
 * 拓宽成 string，AppPaths 联合就提不出来。
 * 视图全部懒加载；AppPaths 供 TypedLink / navigateTo 编译期收窄。
 */
const routes = createRoutes({
  children: [
    {
      path: '/',
      component: () => import('@/views/RootRedirect.js').then((m) => ({ default: m.RootRedirect })),
    },
    {
      path: '/projects/:projectId',
      component: () => import('@/views/ChatPage.js').then((m) => ({ default: m.ChatPage })),
    },
    {
      path: '/projects/:projectId/sessions/:sessionId',
      component: () => import('@/views/ChatPage.js').then((m) => ({ default: m.ChatPage })),
    },
    {
      path: '/projects/:projectId/kanban',
      component: () => import('@/views/KanbanPage.js').then((m) => ({ default: m.KanbanPage })),
    },
    {
      path: '/projects/:projectId/settings',
      component: () => import('@/views/SettingsPage.js').then((m) => ({ default: m.SettingsPage })),
    },
    {
      path: '/settings',
      component: () => import('@/views/SettingsPage.js').then((m) => ({ default: m.SettingsPage })),
    },
  ],
})

/** 全部路由 path 的字面量联合：TypedLink / navigateTo 的 to 以此收窄。 */
export type AppPaths = RoutePaths<typeof routes>

/** TypedLink<AppRoutes> 判别源：只导出类型，路由表与视图间不产生真实模块环。 */
export type AppRoutes = typeof routes

export { routes }
