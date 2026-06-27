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
