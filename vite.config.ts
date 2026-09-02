// src/web/vite.config.ts
import path from 'node:path'
import react from '@vitejs/plugin-react'
import wyw from '@wyw-in-js/vite'
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
      // 首次加载 dev.ts 时缓存 closeDevApp 引用。
      // 关闭阶段不能再调 ssrLoadModule——此时 vite module runner 已关闭会抛错。
      let closeDev: (() => Promise<void>) | null = null

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api')) {
          next()
          return
        }
        try {
          const dev = await server.ssrLoadModule(path.resolve(__dirname, 'src/server/dev.ts'))
          const app = await dev.getDevApp()
          if (!closeDev) closeDev = dev.closeDevApp
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

      // WebSocket：终端双向流。vite HMR 走自己的路径，不冲突。
      // 匹配 /api/terminal/:id/ws → ptyManager.attachWebSocket
      server.httpServer?.on('upgrade', async (req, socket, head) => {
        const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)
        if (!url.pathname.startsWith('/api/terminal/')) return

        const match = url.pathname.match(/^\/api\/terminal\/([^/]+)\/ws$/)
        if (!match) {
          socket.destroy()
          return
        }

        try {
          const dev = await server.ssrLoadModule(path.resolve(__dirname, 'src/server/dev.ts'))
          const ctx = await dev.getDevCtx()
          const ptyId = match[1]

          // Origin 校验（P0-2）：浏览器 WS 不受 CORS 约束，必须在服务端校验。
          const origin = req.headers.origin
          const { isAllowedOrigin } = await server.ssrLoadModule(
            path.resolve(__dirname, 'src/server/middleware/cors.ts'),
          )
          if (
            origin &&
            !isAllowedOrigin(origin, ctx.config.security.allowedOrigins)
          ) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
            socket.destroy()
            return
          }

          // 认证：token 通过 query 参数传递（ctx.authToken，P0-3）。
          const expectedToken = ctx.authToken
          if (expectedToken) {
            const token = url.searchParams.get('token')
            if (token !== expectedToken) {
              socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
              socket.destroy()
              return
            }
          }

          const { WebSocketServer } = await import('ws')
          // 每次创建临时 WSS，handleUpgrade 后即完成（无需持久 WSS 实例）
          const wss = new WebSocketServer({ noServer: true })
          wss.handleUpgrade(req, socket, head, (ws) => {
            const attached = ctx.ptyManager.attachWebSocket(ptyId, ws)
            if (!attached) {
              ws.send(JSON.stringify({ type: 'error', message: 'Terminal not found' }))
              ws.close(1008, 'Terminal not found')
            }
          })
          wss.close() // 释放监听器，连接已由 handleUpgrade 建立完成
        } catch (err) {
          console.error('[c0de-hono-api] ws upgrade error:', err)
          socket.destroy()
        }
      })

      // 关闭时用缓存的引用直接 close PGLite，防止 WAL 损坏导致下次启动 abort。
      // 不抢注 process SIGTERM/SIGINT——vite 自身处理信号并触发 'close' 事件，
      // 此处清理在 vite 优雅关闭流程中执行。
      server.httpServer?.on('close', () => {
        void closeDev?.()
      })
    },
    // dev 模式注入认证 token（P0-3）：页面加载时经 window.__C0DE_AUTH_TOKEN__ 进入 localStorage。
    transformIndexHtml: {
      order: 'pre',
      handler: async (_html, ctx) => {
        try {
          const dev = await ctx.server.ssrLoadModule(path.resolve(__dirname, 'src/server/dev.ts'))
          const srvCtx = await dev.getDevCtx()
          if (!srvCtx?.authToken) return []
          return [
            {
              tag: 'script',
              children: `window.__C0DE_AUTH_TOKEN__=${JSON.stringify(srvCtx.authToken)};`,
              injectTo: 'head',
            },
          ]
        } catch {
          return []
        }
      },
    },
  }
}

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  plugins: [
    // 参考 ../anthology 配置：用 @wyw-in-js/vite（@linaria/vite 的官方继任者）。
    // @linaria/vite@5 是废弃架构，与 vite@8/plugin-react@6 不兼容，css`` 不会被
    // 静态提取，运行时调用 @linaria/core 的 css 会抛 "runtime is not supported"。
    // 组件代码 `import { css } from '@linaria/core'` 无需改动，仅换编译器。
    react({ exclude: ['node_modules/**'] }),
    wyw({
      sourceMap: process.env.NODE_ENV !== 'production',
      displayName: process.env.NODE_ENV !== 'production',
      exclude: ['node_modules/**'],
    }),
    VitePWA({
      registerType: 'autoUpdate',
      // injectRegister:'auto'：插件在「生产构建」自动注入 SW 注册脚本；transformIndexHtml
      // 仅在非 dev 注入该脚本，故 dev 模式只服务 manifest 不注册 SW，避免缓存干扰 HMR。
      // injectRegister 只管注册脚本注入，与 manifest 返回无关（manifest 由 devOptions 控制）。
      injectRegister: 'auto',
      // dev 模式下必须启用，否则 manifest.webmanifest 不会被插件服务，
      // 落到 Vite SPA fallback 返回 index.html，浏览器按 JSON 解析报 Syntax error。
      devOptions: { enabled: true },
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
    outDir: path.resolve(__dirname, 'dist-web'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name].[hash][extname]',
        chunkFileNames: 'assets/[name].[hash].js',
        entryFileNames: 'assets/[name].[hash].js',
        // 代码分割：按明确的包族将稳定的三方依赖单独切 chunk，提升缓存命中率。
        // 注意：Vite 8 后端为 rolldown，`build.rollupOptions` 实为 `rolldownOptions`
        // 的别名；Rollup 的 `manualChunks(id)` 函数在 rolldown 下不生效，须用
        // rolldown 原生 `output.codeSplitting.groups`（test 为正则，priority 越大越优先）。
        // 仅匹配稳定、体积大的包族，未匹配依赖保持 rolldown 默认分块，避免一刀切
        // 破坏按需加载（Settings 懒加载 chunk、各语言语法高亮 chunk 等不受影响）。
        // 正则结尾的 [\\/] 确保只匹配包名边界，react 不会误吞 react-router 等。
        codeSplitting: {
          groups: [
            { name: 'react-query', test: /node_modules[\/]@tanstack[\/]/, priority: 20 },
            { name: 'react-router', test: /node_modules[\/]react-router/, priority: 20 },
            { name: 'linaria', test: /node_modules[\/](@linaria|@wyw-in-js)[\/]/, priority: 20 },
            { name: 'react', test: /node_modules[\/](react|react-dom|scheduler)[\/]/, priority: 20 },
          ],
        },
      },
    },
  },
})
