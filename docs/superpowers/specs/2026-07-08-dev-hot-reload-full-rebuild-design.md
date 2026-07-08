# Dev 热重载全量重建（B 方案）设计

## 1. 背景

现状：`src/server/dev.ts` 把整个 Hono app 缓存在 `globalThis.__c0de_dev_app__`，Vite SSR 重载模块时复用旧 app 对象，导致**新增/修改路由不生效**（如 shake/preview 404）。

此前修复（A 方案）把 app 改成模块级变量、ctx 留 globalThis。但 A 方案只解决了路由层 staleness——活跃 run 与 pending resolver 仍用旧代码，编辑 `core/` 逻辑不生效，是同一 bug 类的更隐蔽形态。

## 2. 目标（B 方案：全量重建，与重启同语义）

| ID | 目标 | 验收 |
|----|------|------|
| G1 | 编辑任意 server/core 代码后热重载，新代码对**新请求**全部生效 | 编辑 health route 字段 → 不重启 → curl 立即返回新字段 |
| G2 | DB handle 跨重载复用（PGLite 单写者约束） | 重载后同一 dataDir 不报 WAL/Aborted，DB 数据保留 |
| G3 | 活跃 run 在重建前被 abort（unwind → 持久化收尾） | rebuild 触发 agentManager.abort 所有 run |
| G4 | pending permission 在重建前 settle 为 deny | rebuild 后 permissionStore.size()==0，无悬空 Promise/timer |
| G5 | 生产路径 `startServer` 行为不变 | server.test.ts 继续通过 |

## 3. 非目标（YAGNI）

- 不迁移活跃 run 的**内存态**（和热升级一样，从最后持久化消息重启）。
- 不做"按变更范围自动选 A/B"的混合策略。
- 不改生产 handoff / 热升级链路。

## 4. 架构

### 4.1 拆分 bootstrap

把 `bootstrapServerContext` 里「建 DB」与「组装 ctx」解耦：

```
createDevDb(cwd): Promise<{ db, closeDb }>   dev 专用：建 + migrate PGLite，跨重载复用
buildServerContext(db, opts): Promise<{ ctx, dispose }>  围绕已有 db 组装全部 ctx 资源
bootstrapServerContext(opts): Promise<BootstrappedServer>  生产入口：建 db → build → close 包 dispose+db.close
```

`dispose` 清理 ctx 资源但**不 close db**（db 由调用方持有）。生产 `startServer` 调 `bootstrapServerContext`，`close` 先 `dispose` 再 `db.close()`。

### 4.2 dispose 语义

新增方法：

- `AgentManager.dispose()` — 遍历所有活跃 run 调 `abortAgent`（loop 在 turn/流边界检测 signal unwind → `finally` 持久化 + unregister）。清空 runs Map。
- `PermissionStore.dispose()` — 所有 pending settle 为 `{ _tag: 'deny', reason: 'Server context disposed (hot reload)' }`，clearTimeout，清 Map。

### 4.3 dev.ts 重建循环

```
globalThis:  devDb + devDbClose      （PGLite 单写者，跨重载唯一存活物）
模块级:      ctx + app + disposeFn   （每次模块重载归 null）
```

`getDevApp()`：app 为 null → `rebuild()`：
1. 若旧 disposeFn 存在 → 调用（abort runs + settle pending + stop scheduler + close handoff）
2. 取/建 devDb（globalThis）
3. `buildServerContext(devDb, { skipHandoff: true })` → ctx + dispose
4. `app = createApp(ctx)`
5. 缓存 disposeFn

`closeDevApp()`：dispose 当前 ctx + closeDb + 清 globalThis。

### 4.4 时序

保存 server 代码 → Vite 重载 dev.ts → 下个请求触发 rebuild → 活跃 run abort（SSE 流以错误关闭，DB 已增量持久化）→ 新 ctx 全用新代码 → 前端再发消息从 DB 历史起新 run。与进程重启同语义，不开新进程。

## 5. 测试策略（TDD）

| 测试文件 | 新增用例 |
|----------|----------|
| `src/server/agent-manager.test.ts` | dispose() abort 所有 run 并清空 |
| `src/server/permission/interactive.test.ts` | dispose() settle 所有 pending 为 deny 并清空 |
| `src/server/server.test.ts` | buildServerContext 围绕复用 db 重建，dispose 后 db 仍可用；DB 数据保留 |

dev.ts 行为由手动验证（编辑 route → 不重启 → curl 生效）保证，已在前序对话验证。

## 6. 改动文件

| 文件 | 改动 |
|------|------|
| `src/server/server.ts` | 抽出 `createDevDb` + `buildServerContext`，`bootstrapServerContext` 委托 |
| `src/server/agent-manager.ts` | +`dispose()` |
| `src/server/permission/store.ts` | +`dispose()` |
| `src/server/dev.ts` | 重写：devDb 留 globalThis，ctx/app 模块级 + rebuild |
| `src/server/types.ts` | AgentManager / PermissionStore 类型加 dispose（如用接口） |
| 3 个 test 文件 | TDD 用例 |
