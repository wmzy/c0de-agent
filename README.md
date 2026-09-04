# c0de-agent

开源 AI 编码助手，采用 Browser-Server 架构（Hono + SSE 后端 / React 前端 / PGLite 本地数据库 / CLI）。

## 特性

- **Browser-Server 架构**：Hono 后端通过 SSE 推送 LLM 流式响应；React 前端单页应用。
- **本地优先**：会话与索引存储在 PGLite（浏览器/进程内 PostgreSQL），数据随用随取。
- **多项目**：工作区隔离的多项目管理，每个项目独立会话历史与配置。
- **工具系统**：内置文件读写、bash、grep、glob、编辑等工具，可按需启用/禁用。
- **权限模式**：`default` / `auto` 等授权模式，控制工具执行前是否需用户确认。
- **会话可恢复**：会话快照序列化/反序列化，支持进程重启后无缝恢复。
- **无感知热更新**：后台定期检查新版本，序列化当前会话 → npm 自更新 → 端口 handoff 接管，用户无感升级。
- **Web 搜索**：内置 websearch 工具，支持多搜索引擎。
- **斜杠命令**：`/compact`、`/model`、`/clear` 等可配置的斜杠命令。
- **会话回收站**：删除会话软删除入回收站，30 天内可恢复。
- **主题**：亮/暗/跟随系统主题。

## 安装

```bash
# 全局安装（推荐）
npm install -g c0de-agent

# 或用 pnpm / yarn
pnpm add -g c0de-agent
```

要求 Node.js >= 22.0.0。

## 安全

- **认证**：`security.authEnabled` 默认开启。首次启动自动生成 bootstrap token（持久化于数据目录 `auth-token` 文件），浏览器首访凭启动打印的 URL `?token=` 注册为**首台设备**，服务端随即**轮换 bootstrap token**（旧 token 立即失效，杜绝 URL/shell 历史泄漏）并下发设备 token；后续 API 请求与终端 WebSocket 均携带设备 token。新增设备无 token 时进入**配对流程**：新设备生成 6 位配对码，由已授权设备在「设备配对」弹窗中核对并批准后下发新设备 token。显式配置 `security.token` 时为静态模式（不轮换、不配对，适合 CI/脚本）。
  - token 解析优先级：`security.token` 配置 > 环境变量 `C0DE_AUTH_TOKEN` > 数据目录 token 文件 > 自动生成并持久化。
  - 显式关闭：`security.authEnabled: false`（本机单用户且端口仅本机可达时）。
  - **设备管理**：`c0de auth list` 列出已授权设备；`c0de auth revoke <id>` 撤销设备（运行中的服务立即生效）；`c0de auth reset` 清除全部设备与 token。运行中的服务会热加载 `devices.json` 的变更。
  - **丢失唯一设备的恢复**：若唯一设备的浏览器数据被清空（设备 token 丢失），配对流程因无已授权设备可批准而无法完成。恢复步骤：`c0de auth reset` → 重启 `c0de serve` → 打开启动日志打印的带 `?token=` 的 URL 重新注册首台设备。
- **CORS/Origin 校验**：仅放行本机回环 origin 与 `security.allowedOrigins` 中显式配置的 origin；WebSocket 升级在服务端独立校验 Origin（浏览器 WS 不受 CORS 约束）。
- **监听地址**：默认绑定 `0.0.0.0`（便于容器/远程访问），安全性由 token + allowedOrigins 保证；需要时可用 `security.allowedOrigins` 收紧或自行反向代理限制。
- **热更新交接**：新实例经环境变量继承 token，请求旧实例 `/handoff` 时须携带匹配的 Bearer token，防止任意本地进程借 handoff 杀掉服务。

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
