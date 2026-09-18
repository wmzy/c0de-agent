import { css } from '@linaria/core'
import { TypedLink, useRouter } from '@native-router/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { TopBar } from '@/components/TopBar.js'
import { navigateTo } from '@/navigateTo.js'
import type { AppPaths } from '@/routes.js'
import { projectAPI } from '@/services/project.js'
import { Layout } from '@/views/Layout.js'

const redirectMsg = css`
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  color: var(--haze-color-text-secondary);
  font-size: 14px;
  padding: 24px;
`

const errorState = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex: 1;
  color: var(--haze-color-text-secondary);
  font-size: 14px;
  padding: 24px;
  text-align: center;
`

const errorIcon = css`
  font-size: 32px;
`

const errorLink = css`
  color: var(--haze-color-primary);
  text-decoration: none;
  padding: 8px 16px;
  border: 1px solid var(--haze-color-primary);
  border-radius: 6px;
`

/**
 * 根路径重定向：解析当前工作区对应项目，跳转到项目路由。
 * history 模式下根路径无项目上下文，必须落到具体项目才能展示会话。
 * 加载中显示提示；失败显示错误引导而非静默循环。
 */
export function RootRedirect() {
  const router = useRouter()
  const {
    data: project,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['project', 'current'],
    queryFn: projectAPI.current,
  })

  // 解析成功 → 命令式跳转项目路由（fire-and-forget，取代/取消由 navigateTo 吞掉）
  useEffect(() => {
    if (project) navigateTo(router, '/projects/:projectId', { params: { projectId: project.id } })
  }, [project, router])

  if (isLoading) {
    return (
      <Layout header={<TopBar />} main={<div className={redirectMsg}>正在解析当前项目…</div>} />
    )
  }
  if (isError || !project) {
    // APIError.message 是后端的中文可操作指引（如「请在项目目录启动 c0de serve」），
    // 直接展示比通用文案更能引导用户走出死胡同。
    const message =
      (error as { message?: string } | null)?.message ??
      '无法解析当前项目，请前往设置确认工作区配置。'
    return (
      <Layout
        header={<TopBar />}
        main={
          <div className={errorState}>
            <span className={errorIcon}>⚠️</span>
            <span>{message}</span>
            <TypedLink<AppPaths> to="/settings" className={errorLink}>
              前往设置
            </TypedLink>
          </div>
        }
      />
    )
  }
  return null
}
