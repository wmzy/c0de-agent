import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/web/**', 'node_modules'],
          testTimeout: 30_000,
          // 动态 import 项目根外的临时文件（如 loader.test.ts 的 /tmp 插件）
          // 走 Node 原生 ESM，不经 vite transform，避免 projects 模式下的 resolve 失败
          server: {
            deps: {
              external: [/^\/tmp\//],
            },
          },
        },
      },
      {
        test: {
          name: 'web',
          environment: 'happy-dom',
          include: ['src/web/**/*.test.{ts,tsx}'],
          setupFiles: ['src/web/test-setup.ts'],
          testTimeout: 15_000,
        },
      },
    ],
  },
})
