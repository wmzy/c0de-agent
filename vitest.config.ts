import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src/web'),
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
    },
  },
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/web/**', 'node_modules'],
          testTimeout: 30_000,
          // 16 核机器上默认按 CPU 数全并行 forks，PGLite（WASM）测试文件并发加载时
          // 易触发 worker 崩溃（"Worker exited unexpectedly"，偶发 2-3 个 worker 挂掉）。
          // 限制并发换取稳定性；配合 src/db/test-utils.ts 的共享 PGlite（每文件 boot 一次
          // + TRUNCATE 重置，替代每用例 ~1.9s 冷启动），4 worker 下全量约 1 分钟。
          maxWorkers: 4,
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
          maxWorkers: 4,
        },
      },
    ],
  },
})
