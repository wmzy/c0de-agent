import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider } from './contexts/ConfigContext.js'
import { ThemeProvider } from './contexts/ThemeContext.js'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, gcTime: 5 * 60_000, retry: 2, refetchOnWindowFocus: true },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ConfigProvider>
          <div>App ready</div>
        </ConfigProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
