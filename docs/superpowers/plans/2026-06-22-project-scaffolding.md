# c0de-agent 项目脚手架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 c0de-agent 的 pnpm monorepo 项目结构，包含 10 个 workspace 包的脚手架、TypeScript 配置、构建配置、lint 配置。

**Architecture:** pnpm workspace monorepo，每个包独立 `package.json` + `tsconfig.json`，共享 `tsconfig.base.json`。Vite 做前端构建，tsx 做后端开发。

**Tech Stack:** pnpm, TypeScript, Vite, Biome (lint/format), React 19, Hono, Drizzle ORM

---

## 文件结构

创建以下目录和文件：

```
c0de-agent/
├── package.json                    根 package.json（pnpm workspace）
├── pnpm-workspace.yaml             workspace 配置
├── tsconfig.base.json              共享 TypeScript 配置
├── tsconfig.json                   根 tsconfig（引用 base）
├── biome.json                      lint/format 配置
├── .gitignore
├── src/
│   ├── core/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── index.ts
│   ├── llm/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── index.ts
│   ├── tools/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── index.ts
│   ├── mcp/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── index.ts
│   ├── plugins/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── index.ts
│   ├── session/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── index.ts
│   ├── db/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── index.ts
│   ├── server/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── index.ts
│   ├── web/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.tsx
│   │       └── App.tsx
│   └── cli/
│       ├── package.json
│       ├── tsconfig.json
│       └── index.ts
```

---

### Task 1: 根项目配置

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `biome.json`
- Create: `.gitignore`

- [ ] **Step 1: 创建根 package.json**

```json
{
  "name": "c0de-agent",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "pnpm -r build",
    "dev": "pnpm --filter @c0de/server dev & pnpm --filter @c0de/web dev",
    "lint": "biome check --write .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "clean": "pnpm -r clean"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "typescript": "^5.9.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: 创建 pnpm-workspace.yaml**

```yaml
packages:
  - "src/*"
```

- [ ] **Step 3: 创建 tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

- [ ] **Step 4: 创建 tsconfig.json**

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "references": [
    { "path": "src/core" },
    { "path": "src/llm" },
    { "path": "src/tools" },
    { "path": "src/mcp" },
    { "path": "src/plugins" },
    { "path": "src/session" },
    { "path": "src/db" },
    { "path": "src/server" },
    { "path": "src/web" },
    { "path": "src/cli" }
  ]
}
```

- [ ] **Step 5: 创建 biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedImports": "error"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  }
}
```

- [ ] **Step 6: 创建 .gitignore**

```
node_modules/
dist/
*.tsbuildinfo
.DS_Store
.env
.env.local
*.log
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: init monorepo root config (pnpm + tsconfig + biome)"
```

---

### Task 2: Core 包脚手架

**Files:**
- Create: `src/core/package.json`
- Create: `src/core/tsconfig.json`
- Create: `src/core/index.ts`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@c0de/core",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.ts"
  },
  "scripts": {
    "build": "tsc --build",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "dependencies": {
    "@c0de/llm": "workspace:*",
    "@c0de/tools": "workspace:*",
    "@c0de/plugins": "workspace:*",
    "@c0de/session": "workspace:*"
  },
  "devDependencies": {
    "typescript": "catalog:"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "composite": true
  },
  "include": ["**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: 创建 index.ts**

```typescript
// @c0de/core - Agent core loop, prompt, config, context management
export const VERSION = '0.0.1'
```

- [ ] **Step 4: Commit**

```bash
git add src/core/
git commit -m "feat: scaffold @c0de/core package"
```

---

### Task 3: LLM 包脚手架

**Files:**
- Create: `src/llm/package.json`
- Create: `src/llm/tsconfig.json`
- Create: `src/llm/index.ts`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@c0de/llm",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.ts"
  },
  "scripts": {
    "build": "tsc --build",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "dependencies": {},
  "devDependencies": {
    "typescript": "catalog:"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "composite": true
  },
  "include": ["**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: 创建 index.ts**

```typescript
// @c0de/llm - Provider abstraction, streaming, token counting
export const VERSION = '0.0.1'
```

- [ ] **Step 4: Commit**

```bash
git add src/llm/
git commit -m "feat: scaffold @c0de/llm package"
```

---

### Task 4: Tools 包脚手架

**Files:**
- Create: `src/tools/package.json`
- Create: `src/tools/tsconfig.json`
- Create: `src/tools/index.ts`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@c0de/tools",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.ts"
  },
  "scripts": {
    "build": "tsc --build",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "dependencies": {
    "@c0de/mcp": "workspace:*"
  },
  "devDependencies": {
    "typescript": "catalog:"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "composite": true
  },
  "include": ["**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: 创建 index.ts**

```typescript
// @c0de/tools - Tool registry, executor, builtin tools
export const VERSION = '0.0.1'
```

- [ ] **Step 4: Commit**

```bash
git add src/tools/
git commit -m "feat: scaffold @c0de/tools package"
```

---

### Task 5: 剩余包脚手架（MCP、Plugins、Session、DB、Server、CLI）

对以下包重复 Task 2-4 的模式：

| 包 | 依赖 |
|---|------|
| `@c0de/mcp` | 无 |
| `@c0de/plugins` | 无 |
| `@c0de/session` | `@c0de/db` |
| `@c0de/db` | 无 |
| `@c0de/server` | `@c0de/core`, `@c0de/session`, `@c0de/db` |
| `@c0de/cli` | `@c0de/core`, `@c0de/server` |

- [ ] **Step 1: 创建 @c0de/mcp**

```bash
mkdir -p src/mcp
```

`src/mcp/package.json`:
```json
{
  "name": "@c0de/mcp",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.ts" },
  "scripts": { "build": "tsc --build", "clean": "rm -rf dist *.tsbuildinfo" },
  "dependencies": {},
  "devDependencies": { "typescript": "catalog:" }
}
```

`src/mcp/tsconfig.json`: 同 Task 2 格式

`src/mcp/index.ts`:
```typescript
// @c0de/mcp - MCP protocol client
export const VERSION = '0.0.1'
```

- [ ] **Step 2: 创建 @c0de/plugins**

```bash
mkdir -p src/plugins
```

`src/plugins/package.json`:
```json
{
  "name": "@c0de/plugins",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.ts" },
  "scripts": { "build": "tsc --build", "clean": "rm -rf dist *.tsbuildinfo" },
  "dependencies": {},
  "devDependencies": { "typescript": "catalog:" }
}
```

`src/plugins/tsconfig.json`: 同格式

`src/plugins/index.ts`:
```typescript
// @c0de/plugins - Plugin loader, lifecycle, hooks
export const VERSION = '0.0.1'
```

- [ ] **Step 3: 创建 @c0de/db**

```bash
mkdir -p src/db
```

`src/db/package.json`:
```json
{
  "name": "@c0de/db",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.ts" },
  "scripts": { "build": "tsc --build", "clean": "rm -rf dist *.tsbuildinfo" },
  "dependencies": {
    "drizzle-orm": "^0.45.0",
    "@electric-sql/pglite": "^0.4.0"
  },
  "devDependencies": {
    "typescript": "catalog:",
    "drizzle-kit": "^0.31.0"
  }
}
```

`src/db/tsconfig.json`: 同格式

`src/db/index.ts`:
```typescript
// @c0de/db - Drizzle ORM + PGLite/PostgreSQL
export const VERSION = '0.0.1'
```

- [ ] **Step 4: 创建 @c0de/session**

```bash
mkdir -p src/session
```

`src/session/package.json`:
```json
{
  "name": "@c0de/session",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.ts" },
  "scripts": { "build": "tsc --build", "clean": "rm -rf dist *.tsbuildinfo" },
  "dependencies": {
    "@c0de/db": "workspace:*"
  },
  "devDependencies": { "typescript": "catalog:" }
}
```

`src/session/tsconfig.json`: 同格式

`src/session/index.ts`:
```typescript
// @c0de/session - Session management, branching, compaction
export const VERSION = '0.0.1'
```

- [ ] **Step 5: 创建 @c0de/server**

```bash
mkdir -p src/server
```

`src/server/package.json`:
```json
{
  "name": "@c0de/server",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.ts" },
  "scripts": { "build": "tsc --build", "dev": "tsx index.ts", "clean": "rm -rf dist *.tsbuildinfo" },
  "dependencies": {
    "hono": "^4.12.0",
    "@hono/node-server": "^2.0.0",
    "@c0de/core": "workspace:*",
    "@c0de/session": "workspace:*",
    "@c0de/db": "workspace:*"
  },
  "devDependencies": { "typescript": "catalog:", "tsx": "^4.0.0" }
}
```

`src/server/tsconfig.json`: 同格式

`src/server/index.ts`:
```typescript
// @c0de/server - Hono HTTP server + SSE
export const VERSION = '0.0.1'
```

- [ ] **Step 6: 创建 @c0de/cli**

```bash
mkdir -p src/cli
```

`src/cli/package.json`:
```json
{
  "name": "@c0de/cli",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": { "c0de": "./index.ts" },
  "scripts": { "build": "tsc --build", "clean": "rm -rf dist *.tsbuildinfo" },
  "dependencies": {
    "@c0de/core": "workspace:*",
    "@c0de/server": "workspace:*"
  },
  "devDependencies": { "typescript": "catalog:", "tsx": "^4.0.0" }
}
```

`src/cli/tsconfig.json`: 同格式

`src/cli/index.ts`:
```typescript
#!/usr/bin/env node
// @c0de/cli - c0de command entry point
console.log('c0de-agent v0.0.1')
```

- [ ] **Step 7: Commit**

```bash
git add src/mcp/ src/plugins/ src/db/ src/session/ src/server/ src/cli/
git commit -m "feat: scaffold remaining packages (mcp, plugins, db, session, server, cli)"
```

---

### Task 6: Web 包脚手架（React + Vite）

**Files:**
- Create: `src/web/package.json`
- Create: `src/web/tsconfig.json`
- Create: `src/web/vite.config.ts`
- Create: `src/web/index.html`
- Create: `src/web/src/main.tsx`
- Create: `src/web/src/App.tsx`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@c0de/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@native-router/react": "^1.0.0",
    "@tanstack/react-query": "^5.0.0",
    "@linaria/core": "^7.0.0",
    "@linaria/react": "^7.0.0"
  },
  "devDependencies": {
    "typescript": "catalog:",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "vite": "^6.0.0",
    "@wyw-in-js/vite": "^1.0.0",
    "vite-plugin-pwa": "^0.21.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: 创建 vite.config.ts**

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { wywInJS } from '@wyw-in-js/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    wywInJS(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'c0de-agent',
        short_name: 'c0de',
        description: 'AI Coding Assistant',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        display: 'standalone',
        icons: []
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        runtimeCaching: [
          {
            urlPattern: /\.[0-9a-f]{8,}\./,
            handler: 'CacheFirst',
            options: {
              cacheName: 'static-assets',
              expiration: { maxEntries: 500, maxAgeSeconds: 7 * 24 * 60 * 60 }
            }
          }
        ]
      }
    })
  ],
  build: {
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name].[hash][extname]',
        chunkFileNames: 'assets/[name].[hash].js',
        entryFileNames: 'assets/[name].[hash].js'
      }
    }
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000'
    }
  }
})
```

- [ ] **Step 4: 创建 index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#1a1a2e" />
  <title>c0de-agent</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 5: 创建 src/main.tsx**

```typescript
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
```

- [ ] **Step 6: 创建 src/App.tsx**

```typescript
import { css } from '@linaria/core'

const appClass = css`
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100dvh;
  font-family: system-ui, sans-serif;
  color: #e6edf3;
  background: #0d1117;
`

export function App() {
  return (
    <div className={appClass}>
      <h1>c0de-agent</h1>
    </div>
  )
}
```

- [ ] **Step 7: Commit**

```bash
git add src/web/
git commit -m "feat: scaffold @c0de/web (React + Vite + PWA)"
```

---

### Task 7: 安装依赖并验证构建

- [ ] **Step 1: 安装依赖**

```bash
pnpm install
```

- [ ] **Step 2: 类型检查**

```bash
pnpm typecheck
```

- [ ] **Step 3: Lint 检查**

```bash
pnpm lint
```

- [ ] **Step 4: 验证前端构建**

```bash
pnpm --filter @c0de/web build
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: install deps, verify typecheck + lint + build"
```
