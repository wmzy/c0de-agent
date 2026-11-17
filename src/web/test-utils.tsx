// 共享测试辅助：QueryClient 工厂 + 带查询上下文的 render 包装。
// 此前 6 个组件测试各持一份同形 renderWithClient 且已现漂移（AddProjectDialog
// 版是裸 new QueryClient，失败用例吃默认 3 次重试；CommitButton 版漏配
// mutations），收敛于此单一出处。需要自持 client 的用例（如 FilePreview 主动
// invalidate 后观察重取）用 makeQueryClient 复用同一默认配置。
import { QueryClient, type QueryClientConfig, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'

export function makeQueryClient(overrides?: QueryClientConfig) {
  return new QueryClient({
    ...overrides,
    defaultOptions: {
      queries: { retry: false, ...overrides?.defaultOptions?.queries },
      mutations: { retry: false, ...overrides?.defaultOptions?.mutations },
    },
  })
}

export function renderWithClient(ui: ReactElement, client: QueryClient = makeQueryClient()) {
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) }
}
