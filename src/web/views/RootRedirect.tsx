import { css } from '@linaria/core'
import { TypedLink, useRouter } from '@native-router/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { TopBar } from '@/components/TopBar.js'
import { navigateTo } from '@/navigateTo.js'
import type { AppPaths } from '@/routes.js'
import { projectAPI } from '@/services/project.js'
import { messageOf } from '@/utils/errors.js'
import { LoadError } from '@/views/_shared/errorState.js'
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

/** 读失败块撑满 Layout 主区（配合 _shared/errorState 居中变体垂直居中）。 */
const errorFill = css`
  flex: 1;
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
    // 直接展示比通用文案更能引导用户走出死胡同。isError 为 false 而 project 缺失时
    // error 可为 null，保持走通用文案。
    const message = error ? messageOf(error) : '无法解析当前项目，请前往设置确认工作区配置。'
    return (
      <Layout
        header={<TopBar />}
        main={
          <LoadError center alert={false} icon="⚠️" detail={message} className={errorFill}>
            <TypedLink<AppPaths> to="/settings" className={errorLink}>
              前往设置
            </TypedLink>
          </LoadError>
        }
      />
    )
  }
  return null
}
