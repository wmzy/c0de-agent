# c0de-agent

开源 AI 编码助手，采用 Browser-Server 架构（Hono + SSE 后端 / React 前端 / PGLite 本地数据库 / CLI）。

## 特性

- **Browser-Server 架构**：Hono 后端通过 SSE 推送 LLM 流式响应；React 前端单页应用。
- **本地优先**：会话与索引存储在 PGLite（浏览器/进程内 PostgreSQL），数据随用随取。
- **多项目**：工作区隔离的多项目管理，每个项目独立会话历史与配置。
- **工具系统**：内置文件读写、bash、grep、glob、编辑等工具，可按需启用/禁用。
- **权限模式**：`default` / `yolo` 等授权模式，控制工具执行前是否需用户确认。
- **会话可恢复**：会话快照序列化/反序列化，支持进程重启后无缝恢复。
- **无感知热更新**：后台定期检查新版本，序列化当前会话 → npm 自更新 → 端口 handoff 接管，用户无感升级。
- **Web 搜索**：内置 websearch 工具，支持多搜索引擎。
- **斜杠命令**：`/compact`、`/model`、`/clear` 等可配置的斜杠命令。
- **主题与多语言**：亮/暗主题，简体中文 / English。

## 安装

```bash
# 全局安装（推荐）
npm install -g c0de-agent

# 或用 pnpm / yarn
pnpm add -g c0de-agent
```

要求 Node.js >= 22.0.0。

## 使用

```bash
# 在项目目录启动
c0de serve

# 指定端口并自动打开浏览器
c0de serve --port 3000 --open

# 从快照恢复会话
c0de serve --restore snapshot.json

# 打印模式（单次问答，不启动服务）
c0de chat "解释这段代码"

# 更新检查
c0de update --check
```

启动后访问 `http://localhost:3000`。

## 开发

```bash
# 安装依赖
pnpm install

# 启动开发服务器（前端热更新）
pnpm dev

# 类型检查
pnpm typecheck       # 后端
pnpm typecheck:web   # 前端

# 测试
pnpm test

# 构建
pnpm build         # 编译 CLI/后端到 dist/
pnpm build:web     # 构建前端到 dist-web/

# 代码检查与格式化
pnpm lint
pnpm format
```

## 架构

```
src/
├── cli/           # CLI 入口与命令（serve / chat / acp / update / config / init / plugin）
├── core/          # 配置、agent 注册与主循环（loop/ 子模块）、权限、prompt、工作流、斜杠命令
├── llm/           # LLM provider 抽象、registry 与重试策略
├── server/        # Hono HTTP 服务、SSE 流、路由、鉴权/CORS、交互式权限、终端（node-pty）
├── session/       # 会话上下文、消息、compaction、branch/squash、快照
├── project/       # 多项目解析与检测（.git、package.json 等）
├── db/            # Drizzle schema 与迁移（PGLite）
├── tools/         # 内置工具实现（read/write/edit/bash/grep/glob/todo/kanban/dap/websearch…）
├── plugins/       # 插件系统（12 个生命周期钩子）
├── dap/           # Debug Adapter Protocol 会话与协议编解码
├── shared/        # 前后端共享类型
├── update/        # 版本检查、热更新调度器、会话快照
├── kanban/        # 看板状态存储
└── web/           # React 前端（组件、视图、服务、hooks）
```

## 发布

采用 [semantic-release](https://github.com/semantic-release/semantic-release) 自动化发布，基于 conventional commits（`feat:`、`fix:`、`refactor:` 等）自动计算版本号、生成 changelog 并发布到 npm。

- `main` 分支推送触发 `.github/workflows/release.yml`
- 通过 GitHub Actions OIDC trusted publishing 发布（无需 NPM_TOKEN）
- 发布产物带 npm provenance（可验证来源）

## License

[MIT](./LICENSE)
