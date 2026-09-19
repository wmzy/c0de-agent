# c0de-agent

开源 AI 编码助手，采用 Browser-Server 架构（Hono + SSE 后端 / React 前端 / PGLite 本地数据库 / CLI）。

## 特性

- **Browser-Server 架构**：Hono 后端通过 SSE 推送 LLM 流式响应；React 前端单页应用。
- **本地优先**：会话与索引存储在 PGLite（浏览器/进程内 PostgreSQL），数据随用随取。
- **多项目**：工作区隔离的多项目管理，每个项目独立会话历史与配置。项目目录被**移动/重命名**后，顶栏「目录已失效」提示提供「重新定位」——输入新路径即可把会话与看板整体迁移过去（无需删除项目）。设置页区分「项目/全局」两个配置作用域；**首次添加 Provider 且全局尚无任何 AI 服务时会提示一次保存到全局作用域（所有项目与 CLI 可见）还是仅当前项目**——项目作用域的 Provider 只在该项目生效，其他项目与 `c0de chat` 不可见。前端默认模型选择会校正失效组合：`defaultProvider`/`defaultModel` 不在已配置 provider 的模型清单时，自动回退到首个已配置 provider 与其首个声明模型。
- **工具系统**：内置文件读写、bash、grep、glob、编辑等工具，可按需启用/禁用（`tools.enabled` 与 `slashCommands.enabled` 语义统一 fail-closed：含 `'*'` = 全部，显式名单 = 仅名单内，**空数组 = 全部禁用**——旧版「空=全部启用」的配置升级后会收到迁移告警引导改 `['*']`）。
- **权限模式**：`default` / `auto` 等授权模式，控制工具执行前是否需用户确认。权限确认双层超时（`permission.timeoutMs` / `permission.expireGraceMs`，默认 5 分钟 + 25 分钟，设置页可调）：首层超时仅提示（可在弹窗中重新确认，不重发消息）；宽限期满仍未响应则自动拒绝。默认在拒绝后**暂停对话**（等你点击「恢复」继续，agent 不会在无人确认时继续自主执行）；`permission.timeoutAction: 'deny'` 可改回旧行为（拒绝后对话继续，会话永不挂起）。
- **项目信任边界**：项目级 `.c0de/config.json` 与 `.c0de/plugins` 默认**不自动生效**——克隆一个携带这些文件的仓库后，若其配置把权限降级为 `auto`、要求启用项目插件、声明了 MCP 服务器、或把 `providers[].baseURL` 指向自定义端点（你的提示词将发往该地址），Web 聊天入口会弹出「信任此项目？」确认（明示每一项风险），显式信任后才放行；CLI（`c0de chat` / `c0de acp`）无确认弹窗，遇到未信任项目的风险配置会直接拒绝并引导 `c0de trust <dir> --yes`（`c0de trust` 会先打印将接受的风险清单，有风险时必须 `--yes` 确认，不盲信任）。信任**非一次性**——信任时落盘项目风险配置指纹，若仓库后续 `git pull` 新增 `auto`/插件/MCP/自定义 baseURL 等风险键，**或修改了 MCP 参数（如同名改 args）与插件代码（如同名改文件内容）**，指纹漂移会重新触发确认（可随时收回项目级配置）；项目插件本就在项目未信任时不加载（`c0de trust` 或 Web 信任后重启 serve 生效），**已信任项目指纹漂移后同样不加载**（与聊天门禁同口径，重启也不会执行漂移后的插件代码）。**`security.*` 是服务端全局参数，不参与项目作用域合并**（加载时整体剥离：`authEnabled`/`token`/`allowedOrigins` 等只能在本机全局配置设置）——克隆仓库无法借 `.c0de/config.json` 静默关闭鉴权、植入已知弱 token 或放宽 CORS 来源；项目配置中遗留的 `security` 键会在设置页告警「已忽略」，Web 设置/`c0de config set` 对项目作用域写入 `security` 会直接拒绝并引导改全局。全局配置（`~/.c0de/config.json`）是你本机的显式编辑，其 `permission.defaultMode: auto` / `permission.timeoutAction: deny` 会直接作用于所有项目；为防「本机全局 auto 让无 `.c0de` 的克隆仓库跳过信任门禁全自动执行」，**未信任项目 + 全局权限风险同样触发一次性信任确认**（信任后全局不复检；全局插件/MCP 仍是本机显式安装、不参与门禁）。信任确认弹窗会把项目与全局风险一并列明供你知情。
- **会话可恢复**：会话快照序列化/反序列化，支持进程重启后无缝恢复。
- **无感知热更新**：后台定期检查新版本，安装成功后才暂停活跃会话 → 序列化会话快照 → npm 自更新 → 端口 handoff 接管。空闲会话零感知；进行中的对话会中断（界面提示后可一键重发继续），中断前的半截回复与工具结果会在时间线置灰标记为「未完成轮次」并**从上下文剔除**（重发后不影响新对话），安装失败时不触碰任何会话状态。**终端面板**：应用更新前会列出将被关闭的终端（含标题/目录，分级确认弹层需输入版本号确认）；快照携带终端元信息，新实例启动后按原 id 在**原位重建 shell**（刷新页面后终端布局无感重连；终端内正在运行的进程如 dev server 无法续命，会随旧实例停止）。应用更新确认层还会列出**等待确认的权限请求数**——更新会使其弹窗失效（该工具按拒绝处理），避免用户盯着弹窗却被静默终断；进行中的对话逐项标注运行态——**正在执行工具的 run 会先等待其完成，超时未暂停将被强制中止（其子进程会被终止）**，已暂停的 run 标为「安全点」。更新完成后请**刷新页面**加载新版界面（后续请求已自动落到新实例，不刷新则页面仍运行旧版前端）。
- **追加指令**：对话进行中可注入「追加指令」（steering），立即影响下一轮模型输出，并作为会话历史的一部分持久化——刷新后不丢失。
- **故障回退**：主 provider 失败时自动重试；启用后按配置的重试参数执行，并回退到声明了同一模型的其他 provider（设置 → 故障回退）。
- **斜杠命令**：`/compact`、`/model`、`/clear` 等可配置的斜杠命令（`slashCommands.enabled` 与 `tools.enabled` 同为 fail-closed 语义）。
- **分支（fork）**：会话可在任意消息处分支为独立会话。分支继承分支点之前的完整上下文——包括压缩/清理归档（归档面板可查）、用量统计（token 徽标/会话信息面板显示继承成本；新调用按实际发生记账，不重复计费），以及权限态（会话级 `auto` 模式与「始终允许」白名单）与 CLI 会话的工作目录。
- **会话回收站**：删除会话软删除入回收站，保留 60 天（自**首次打开回收站看到该分组**起算——分组粒度、只标记一次，不随每次打开重置，倒计时稳定可预期；从未被查看的条目自删除起最长保留 365 天后进入宽限期，不会无限滞留）可恢复（按项目隔离，恢复时自动重新归属）。到期后先进入 **7 天宽限期**（回收站内明示「即将清除」，仍可恢复），宽限期满才物理清除，绝不静默清空。回收站列表按到期紧迫度排序（宽限期内条目置顶，其次按到期先后）。删除项目会将其会话移入回收站的「未归属项目」分组（跨项目可见），该分组默认折叠，展开时才启动保留期倒计时；恢复此类会话时可**二选一**：「恢复到当前项目」或「恢复并重建原项目」（原目录仍存在时重建项目记录，响应与界面明示重建的项目，不再静默复活已删除的项目）。恢复会话时仅还原同一次删除操作中一并删除的分支，漏掉的分支会在提示中显式告知数量；恢复前确认框会列出将连带还原的父会话。
- **会话导出/导入**：会话可导出为 JSON 备份，并在任意项目重新导入（会话列表「导入」按钮），跨机器迁移或本地备份均可用。导出含权限态（自动授权/始终允许白名单）时，导入前会明示风险并让你选择是否随迁——默认剥离，避免导入他人导出的会话时静默继承对危险工具的免确认放行；归档中的**文件快照（被压缩进上下文的文件内容）默认剥离**，导出对话框显式确认后才携带，分享导出 JSON 不泄露文件内容。用量统计（segments）随导入携带、会话信息面板/徽标保留历史成本与 token 口径，但**导入的调用不进入本机成本账本**（`usage_events`）——跨机器导入的历史消费不污染本地月度成本与预算护栏；且 segments 按导入消息时间窗裁剪。导出仅含本会话与归档；有派生分支时会先提示分支内容不会随迁。
- **看板**：项目级任务看板（与会话内 agent 待办相互独立，可把待办导出为看板卡片），支持导出/导入整板 JSON 备份。**删除项目不再永久销毁看板**——看板随项目软删除进入回收站「未归属看板」分组（删除后保留 60 天，到期先进入 7 天宽限期——明示「即将清除」仍可恢复——宽限期满才物理清除，绝不静默清空），可「恢复到当前项目」、「恢复并重建原项目」（原目录仍存在时重建项目记录）或彻底删除。目录只是被移动/重命名时请用「重新定位」整体迁移，不要用删除。
- **工作流**：内置/用户级（`~/.c0de/workflows`）/项目级（`.c0de/workflows`）三级工作流脚本，聊天中 `/workflow run <name>` 或 REST `POST /api/workflows/:name/run` 执行（信任门禁、预算护栏、权限确认与主对话同口径；`meta.timeout` 超时中止执行）。设置页「工作流」面板可查看源码、新建、编辑、删除（删除需输入名称确认）。
- **会话用量**：会话列表每行显示累计 token 徽标；会话页「会话信息」面板提供 token/成本/消息数等完整统计（token 为服务端上报用量，成本按配置价目估算）。设置页「用量与成本」面板提供**项目口径**聚合：总量、按月、按模型统计，并可设置月度成本预算（`usage.monthlyBudgetUsd`）与超支动作（`usage.budgetAction: 'warn' | 'pause'`）——`warn` 仅告警（当月成本达预算 80% 徽标变警示色、超预算变红），`pause` 在新一轮回复前暂停对话（等同权限超时暂停机制，点「恢复」继续，本 run 不再重复暂停）；CLI（`c0de chat`）无「恢复」交互，`pause` 时在入口单次拒绝、并每轮 LLM 请求前复查、超支即中止 run 明示超支（`warn` 不变，仅告警）；默认 `warn`。另可设置**全局月度预算**（`usage.globalMonthlyBudgetUsd`，所有项目+未归属调用聚合，仅全局作用域生效）作兜底护栏——与项目预算并存，任一超支即触发动作；另支持**月度 token 预算**（`usage.monthlyTokenBudget` / `usage.globalMonthlyTokenBudget`，input+output+cacheRead tokens 之和）——价格独立护栏，兜底「自建网关/未登记模型 cost 恒 $0、金额护栏拦不住」的场景（token 预算动作由 `usage.tokenBudgetAction` 独立控制，缺省回退 `budgetAction`；`pause` 时超支暂停/拒绝，`warn` 下仅顶栏徽标与「用量与成本」面板告警、不暂停对话）；「未归属项目」的调用（CLI 未绑定会话/孤儿会话）单独统计展示，且**只受全局口径预算约束**——只设项目预算、未设全局预算时，这些调用没有任何护栏（设置页会告警提示补充全局预算）。**本月口径由服务端本地时区计算下发**，前端徽标/面板与预算暂停判定同源一致（远程访问/容器时区不同也不会错报）。成本是账本：写入独立的 `usage_events` 表，**会话彻底删除（含回收站到期物理清除）后已发生花费仍计入**；价格未知的调用（自建网关/未登记模型）按 $0 计入并单独计数提示，内置价目标注最近核价日期（估算可能随价格变动过期，实际费用以账单为准）。顶栏显示**本月成本徽标**（按当前项目口径），点击直达用量面板。
- **主题**：亮/暗/跟随系统主题。

## 安装

```bash
# 全局安装（推荐）
npm install -g c0de-agent

# 或用 pnpm / yarn
pnpm add -g c0de-agent
```

要求 Node.js >= 22.0.0。

> **首次使用前先配置 AI 服务**：项目默认不携带 `providers`（`providers: []`）。启动
> `c0de serve` 后，先在 Web 界面「设置 → Provider」添加 API 服务并「测试连接」，或在
> `~/.c0de/config.json` 中手动写入 `providers`（`c0de config set providers …`）。未配置
> provider 时发送消息会得到「未配置可用的 AI 服务」引导，而非模型响应。

## 安全

- **密钥存储**：`config.json` 写入时强制 `chmod 600`；`providers[].apiKey` 与 `websearch.tavilyApiKey/braveApiKey` 落盘前自动加密（AES-256-GCM，机器绑定，`enc:` 前缀），无论经 Web 设置、`c0de config set` 还是 `/config` 斜杠命令写入均不落明文。例外：`security.token`（静态模式专用）以明文存储，仅建议 CI/脚本场景使用，交互使用请走设备配对。`/config` 与 `c0de config get` 展示配置时对 apiKey/token 等字段自动脱敏。
  - 项目级配置（`<项目>/.c0de/config.json`）含密钥且目录在 git 仓库内时，设置页会提示将 `.c0de/` 加入 `.gitignore`，防止误提交。
- **认证**：`security.authEnabled` 默认开启。首次启动自动生成 bootstrap token（持久化于数据目录 `auth-token` 文件），浏览器首访凭启动打印的 URL `?token=` 注册为**首台设备**，服务端随即**轮换 bootstrap token**（旧 token 立即失效，杜绝 URL/shell 历史泄漏）并下发设备 token；后续 API 请求与终端 WebSocket 均携带设备 token。新增设备无 token 时进入**配对流程**：新设备生成 6 位配对码，由已授权设备在「设备配对」弹窗中**输入对方屏幕显示的 6 位配对码**（服务端核对匹配，防多个请求并存时看错行误批）批准后下发新设备 token（设备**在 token 实际交付时**才登记——审批后、新设备取 token 前若服务重启，审批态随内存清空、重新配对即可，不会留下「已授权却永远拿不到 token」的僵尸设备条目）。显式配置 `security.token` 时为静态模式（不轮换、不配对，适合 CI/脚本）。**已有已注册设备后**，`c0de serve` 打印的启动 URL 不再携带 `?token=`（那已是轮换失效的旧值）——新浏览器直接走配对流程，已注册浏览器凭 localStorage 中的设备 token 无缝使用。
  - **首设备先到先得**：任何能看见启动打印 URL 的人（同机其他用户、终端输出被截图/共享）都能抢先注册为首台设备，随后真实用户只能经其配对审批。请勿在共享主机或会被录屏的场景让 URL 暴露。默认防护：bootstrap token 生成后 **5 分钟**内有效（`security.firstDeviceTtlMs` 默认值），超时需重启 `c0de serve`（无已注册设备时重启会重新生成 bootstrap，窗口随之刷新）；共享主机/CI 等场景可显式配置更短的值。
  - token 解析优先级：`security.token` 配置 > 环境变量 `C0DE_AUTH_TOKEN` > 数据目录 token 文件 > 自动生成并持久化。
  - 显式关闭：`security.authEnabled: false`（本机单用户且端口仅本机可达时）。
  - **设备管理**：`c0de auth list` 列出已授权设备；`c0de auth revoke <id>` 撤销设备（运行中的服务立即生效）；`c0de auth reset` 清除全部设备与 token。运行中的服务会热加载 `devices.json` 的变更。
  - **丢失唯一设备的恢复**：若唯一设备的浏览器数据被清空（设备 token 丢失），配对流程因无已授权设备可批准而无法完成。恢复步骤：`c0de auth reset` → 重启 `c0de serve` → 打开启动日志打印的带 `?token=` 的 URL 重新注册首台设备。新设备的配对界面检测到服务端**零已授权设备**时会直接展示上述恢复指引（并停止无意义的审批轮询），不再干等一个不可能到来的批准。
- **CORS/Origin 校验**：仅放行本机回环 origin 与 `security.allowedOrigins` 中显式配置的 origin；WebSocket 升级在服务端独立校验 Origin（浏览器 WS 不受 CORS 约束）。**认证关闭（`authEnabled: false`）时另有跨域写防线**：携带非本地/未配置 Origin 的 POST/PUT/PATCH/DELETE 请求会被 403 拒绝（CORS 回显只拦「读」，恶意网页仍可对本地服务盲发副作用请求；带合法 token 时由 token 防线覆盖）。无 Origin 的请求（curl/CLI/脚本）不受影响。
- **监听地址**：默认绑定 `127.0.0.1`（仅本机可达，安全默认）。容器/远程访问需显式 `c0de serve --host 0.0.0.0`（或局域网 IP）——启动时会打印**醒目警告**，此时安全性由 token + allowedOrigins 保证；需要时可用 `security.allowedOrigins` 收紧或自行反向代理限制。
- **热更新交接**：新实例经环境变量继承 token，请求旧实例 `/handoff` 时须携带匹配的 Bearer token，防止任意本地进程借 handoff 杀掉服务。

## 使用

```bash
# 在项目目录启动
c0de serve

# 指定端口并自动打开浏览器（默认 7310）
c0de serve --port 8080 --open

# 从快照恢复会话
c0de serve --restore snapshot.json

# 打印模式（单次问答，不启动服务）
c0de chat "解释这段代码"

# serve 运行时打印模式默认拒绝（对话无法持久化），显式接受临时模式：
c0de chat --temp "解释这段代码"

# 打印模式默认拒绝写工具；--allow 定向放行指定写工具（或用 -y 全量放行）
c0de chat --allow write,bash "修复这个函数"

# 更新检查
c0de update --check

# 信任项目目录：启用其项目级配置与 .c0de/plugins（克隆仓库审查后显式执行；
# 含风险配置时需 --yes——不带 --yes 会先打印风险清单供审查）
c0de trust /path/to/cloned-repo --yes
```

启动后访问 `http://localhost:7310`。

> **CLI 与 Web 的会话互通**：`c0de chat --continue` 续接过的 CLI 会话与 Web 会话在
> Web 会话树中**同树展示**（带 `CLI` 徽标；所在目录已注册为项目时归入该项目，否则在
> 列表底部的「CLI 会话（未绑定项目）」分组）；一次性问答（未续接）仍是临时会话，
> 不进入 Web 树，30 天后自动移入回收站（走回收站保留期，可恢复）。`c0de sessions list` 会列出全部会话
> （`[cli]`/`[web]` 标注），并可删除/恢复/彻底删除任意会话（`c0de sessions purge <id> --yes`
> 永久删除、`--all --yes` 清空回收站；`deleted` 子命令列出回收站并启动 60 天保留期倒计时，
> 与 Web 打开回收站同口径；`--project <路径>` 可把「看到」标记与列表限定到单个项目）。
> 注意：数据库为单写者，`c0de sessions` / `c0de chat`（非 `--temp`）在 serve 运行期间会报错拒绝
> （CLI 管理需先停止 serve）——报错会直接给出**运行中 serve 的 Web 地址**，打开浏览器即可继续。
> 已删除（在回收站中）的会话不可被 `--continue` 续接——报错会给出恢复途径
> （Web 回收站恢复，或停止 serve 后 `c0de sessions restore <id>`）。
> 恢复的会话若原项目目录已不存在（孤儿会话），可用 `c0de sessions restore <id> --project <路径>`
> 显式归属到项目。两者存于同一数据库。`c0de chat --continue` 续接过的 CLI 会话不会被自动清理；
> 未续接的一次性问答会话 30 天后自动移入回收站。

## 开发

```bash
# 安装依赖
pnpm install

# 启动开发服务器（前端热更新，端口 3020）
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

> **开发环境隔离**：`.env.example` 是开发隔离模板（复制为 `.env` 后生效，`.env` 不入 git）。
> 它把 dev server 的全局配置/工作流/插件（`C0DE_CONFIG_DIR`）与运行时数据 DB/设备认证
> （`C0DE_DB_DIR`）从安装版默认位置（`~/.c0de`、`~/.local/share/c0de/pglite`）重定向到
> 仓库内 `.c0de-dev/`（已 gitignore），与 `npm i -g c0de-agent` 安装版互不干扰、
> 可同时运行。两个变量经 `vite.config.ts` 在 dev server 启动时注入进程环境
> （vite 8 不再自动把 `.env` 合并进 `process.env`）。

## 架构

```
src/
├── cli/           # CLI 入口与命令（serve / chat / acp / update / config / init / plugin / sessions / trust）
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
