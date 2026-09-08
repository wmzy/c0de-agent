# c0de-agent

开源 AI 编码助手，采用 Browser-Server 架构（Hono + SSE 后端 / React 前端 / PGLite 本地数据库 / CLI）。

## 特性

- **Browser-Server 架构**：Hono 后端通过 SSE 推送 LLM 流式响应；React 前端单页应用。
- **本地优先**：会话与索引存储在 PGLite（浏览器/进程内 PostgreSQL），数据随用随取。
- **多项目**：工作区隔离的多项目管理，每个项目独立会话历史与配置。项目目录被**移动/重命名**后，顶栏「目录已失效」提示提供「重新定位」——输入新路径即可把会话与看板整体迁移过去（无需删除项目）。
- **工具系统**：内置文件读写、bash、grep、glob、编辑等工具，可按需启用/禁用。
- **权限模式**：`default` / `auto` 等授权模式，控制工具执行前是否需用户确认。权限确认双层超时：5 分钟未确认仅提示（可在弹窗中重新确认，不重发消息）；再过 25 分钟仍未响应则自动拒绝（run 继续执行，会话不会无限挂起）。
- **会话可恢复**：会话快照序列化/反序列化，支持进程重启后无缝恢复。
- **无感知热更新**：后台定期检查新版本，安装成功后才暂停活跃会话 → 序列化会话快照 → npm 自更新 → 端口 handoff 接管。空闲会话零感知；进行中的对话会中断（界面提示后可一键重发继续），安装失败时不触碰任何会话状态。更新完成后请**刷新页面**加载新版界面（后续请求已自动落到新实例，不刷新则页面仍运行旧版前端）。
- **追加指令**：对话进行中可注入「追加指令」（steering），立即影响下一轮模型输出，并作为会话历史的一部分持久化——刷新后不丢失。
- **故障回退**：主 provider 失败时自动重试；启用后按配置的重试参数执行，并回退到声明了同一模型的其他 provider（设置 → 故障回退）。
- **斜杠命令**：`/compact`、`/model`、`/clear` 等可配置的斜杠命令。
- **会话回收站**：删除会话软删除入回收站，保留 60 天（自**首次在回收站看到该条目**起算——只标记一次，不随每次打开重置，倒计时稳定可预期）可恢复（按项目隔离，恢复时自动重新归属）。到期后先进入 **7 天宽限期**（回收站内明示「即将清除」，仍可恢复），宽限期满才物理清除，绝不静默清空。删除项目会将其会话移入回收站的「未归属项目」分组（跨项目可见，恢复时归属到某项目）；该分组默认折叠，展开时才启动保留期倒计时。恢复会话时仅还原同一次删除操作中一并删除的分支，漏掉的分支会在提示中显式告知数量。
- **会话导出/导入**：会话可导出为 JSON 备份，并在任意项目重新导入（会话列表「导入」按钮），跨机器迁移或本地备份均可用。导出含权限态（自动授权/始终允许白名单）时，导入前会明示风险并让你选择是否随迁——默认剥离，避免导入他人导出的会话时静默继承对危险工具的免确认放行。导出仅含本会话与归档；有派生分支时会先提示分支内容不会随迁。
- **看板**：项目级任务看板（与会话内 agent 待办相互独立，可把待办导出为看板卡片），支持导出/导入整板 JSON 备份——注意：删除项目会**永久**级联删除看板（会话有回收站，看板没有），删除前请先导出备份；目录只是被移动/重命名时请用「重新定位」整体迁移，不要用删除。
- **会话用量**：会话列表每行显示累计 token 徽标；会话页「会话信息」面板提供 token/成本/消息数等完整统计（token 为服务端上报用量，成本按配置价目估算）。
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

- **密钥存储**：`config.json` 写入时强制 `chmod 600`；`providers[].apiKey` 与 `websearch.tavilyApiKey/braveApiKey` 落盘前自动加密（AES-256-GCM，机器绑定，`enc:` 前缀），无论经 Web 设置、`c0de config set` 还是 `/config` 斜杠命令写入均不落明文。例外：`security.token`（静态模式专用）以明文存储，仅建议 CI/脚本场景使用，交互使用请走设备配对。`/config` 与 `c0de config get` 展示配置时对 apiKey/token 等字段自动脱敏。
  - 项目级配置（`<项目>/.c0de/config.json`）含密钥且目录在 git 仓库内时，设置页会提示将 `.c0de/` 加入 `.gitignore`，防止误提交。
- **认证**：`security.authEnabled` 默认开启。首次启动自动生成 bootstrap token（持久化于数据目录 `auth-token` 文件），浏览器首访凭启动打印的 URL `?token=` 注册为**首台设备**，服务端随即**轮换 bootstrap token**（旧 token 立即失效，杜绝 URL/shell 历史泄漏）并下发设备 token；后续 API 请求与终端 WebSocket 均携带设备 token。新增设备无 token 时进入**配对流程**：新设备生成 6 位配对码，由已授权设备在「设备配对」弹窗中核对并批准后下发新设备 token。显式配置 `security.token` 时为静态模式（不轮换、不配对，适合 CI/脚本）。
  - **首设备先到先得**：任何能看见启动打印 URL 的人（同机其他用户、终端输出被截图/共享）都能抢先注册为首台设备，随后真实用户只能经其配对审批。请勿在共享主机或会被录屏的场景让 URL 暴露。默认防护：bootstrap token 生成后 **5 分钟**内有效（`security.firstDeviceTtlMs` 默认值），超时需重启 `c0de serve`（无已注册设备时重启会重新生成 bootstrap，窗口随之刷新）；共享主机/CI 等场景可显式配置更短的值。
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

# serve 运行时打印模式默认拒绝（对话无法持久化），显式接受临时模式：
c0de chat --temp "解释这段代码"

# 更新检查
c0de update --check
```

启动后访问 `http://localhost:3000`。

> **CLI 与 Web 的会话隔离**：`c0de chat` 产生的会话标记为 `cli` 来源，不会出现在
> Web 界面的会话树中（Web 会话树仅展示 web 会话）。CLI 侧 `c0de sessions list` 会列出
> 全部会话（`[cli]`/`[web]` 标注），并可删除/恢复任意会话——这是 Web 会话的 CLI 恢复途径。
> 注意：数据库为单写者，`c0de sessions` / `c0de chat`（非 `--temp`）在 serve 运行期间会报错拒绝
> （CLI 管理需先停止 serve；运行中的服务请用 Web 界面管理）。
> 恢复的会话若原项目目录已不存在（孤儿会话），可用 `c0de sessions restore <id> --project <路径>`
> 显式归属到项目。两者存于同一数据库。`c0de chat --continue` 续接过的 CLI 会话不会被自动清理；
> 未续接的一次性问答会话 30 天后自动清除。

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
