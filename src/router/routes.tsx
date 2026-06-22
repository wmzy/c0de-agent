import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

export type PageLoader = () => Promise<{ default: ComponentType<unknown> }>

export const lazyPage = (loader: () => Promise<unknown>): LazyExoticComponent<ComponentType<unknown>> =>
  lazy(loader as () => Promise<{ default: ComponentType<unknown> }>)

interface RouteEntry {
  Component: LazyExoticComponent<ComponentType<unknown>>
  preload: () => Promise<unknown>
}

const defineRoute = (loader: () => Promise<unknown>): RouteEntry => ({
  Component: lazy(loader as () => Promise<{ default: ComponentType<unknown> }>),
  preload: loader,
})

export const ROUTE_PAGES: Record<string, RouteEntry> = {
  '/chat': defineRoute(() => import('../pages/ChatPage')),
  '/settings': defineRoute(() => import('../pages/SettingsPage')),
}

export interface NavItem {
  path: string
  label: string
}

export const ROUTE_NAV_ITEMS: NavItem[] = [
  { path: '/chat', label: '对话' },
  { path: '/settings', label: '设置' },
]
