import { useQuery } from '@tanstack/react-query'
import { providerAPI } from '@/services/provider.js'

/**
 * 选中模型是否支持图片输入（composer 附件栏据此隐藏/警告图片入口）。
 *
 * projectId 是必需的，不是可选优化：服务端 `/api/providers/capabilities` 在没有
 * projectId 时回落到 **c0de 启动目录** 的配置与注册表（resolveForProject 直接
 * `return { config: ctx.config, registry: ctx.llmRegistry }`）。于是项目作用域里
 * 独有的 provider/model 解析不到 → 404；更糟的是同名 provider 会拿到启动目录
 * 那份的能力，答案直接是错的。
 *
 * 读不到时一律按「支持」处理（fail-open）：能力查询是一次辅助校验，为它去禁用
 * 图片入口，代价（用户发不了图）比放行后 provider 自己 400 更糟，且 400 的错误
 * 里已经写明是图片不被支持。
 */
export function useSupportsVision(
  projectId: string | undefined,
  selection: {
    provider?: string
    model?: string
  },
): boolean {
  const { provider, model } = selection
  const { data } = useQuery({
    queryKey: ['capabilities', projectId, provider, model],
    queryFn: () => providerAPI.capabilities(provider ?? '', model ?? '', projectId),
    enabled: Boolean(provider && model),
    staleTime: 60_000,
    retry: false,
  })
  return data?.supportsVision ?? true
}
