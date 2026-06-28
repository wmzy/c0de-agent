// src/web/vite.config.ts
import path from 'node:path'
import linaria from '@linaria/vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * 把后端 Hono app 挂到 vite dev server 的 /api 中间件，
 * 通过 ssrLoadModule 加载 src/server/dev.ts，实现开发期前后端单端口。
 */
function honoApiPlugin(): Plugin {
  return {
    name: 'c0de-hono-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api')) {
          next()
          return
        }
        try {
          const dev = await server.ssrLoadModule(path.resolve(__dirname, '../server/dev.ts'))
          const app = await dev.getDevApp()
          await dev.handleApiRequest(app, req, res)
        } catch (err) {
          console.error('[c0de-hono-api] error:', err)
          if (!res.headersSent) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
          }
          res.end(JSON.stringify({ error: 'Internal Server Error', message: String(err) }))
        }
      })
    },
  }
}

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  plugins: [
    react(),
    linaria({
      include: ['**/*.{ts,tsx}'],
    }),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        name: 'c0de-agent',
        short_name: 'c0de',
        description: 'AI Coding Assistant',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        display: 'standalone',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        runtimeCaching: [
          {
            urlPattern: /\.[0-9a-f]{8,}\./,
            handler: 'CacheFirst',
            options: {
              cacheName: 'static-assets',
              expiration: { maxEntries: 500, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
    honoApiPlugin(),
  ],
  server: {
    port: 3020,
    host: true,
    // 单端口方案：/api 由 honoApiPlugin 直接处理后端，无需独立后端端口与代理。
  },
  ssr: {
    // hono 走 vite 转译避免 ESM/CJS 边界；pglite/drizzle 等走 Node 原生加载
    noExternal: ['hono'],
  },
  build: {
    outDir: path.resolve(__dirname, '../../dist-web'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name].[hash][extname]',
        chunkFileNames: 'assets/[name].[hash].js',
        entryFileNames: 'assets/[name].[hash].js',
      },
    },
  },
})
