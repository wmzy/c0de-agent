// 服务级配置同步单点：global 作用域（或 serve 目录项目作用域）配置写盘后，
// 内存态（ctx.config / registry / permissionMode / 项目注册表缓存）如何随之
// 重建。此前 config PATCH 与 permissions PUT 两条通道各持一份（后者干脆不同步
// ctx.config），且 PATCH 的裸 mergeConfig 重建会丢掉插件 config:resolve 链的
// 产物（启动时 server.ts 用 resolvedConfig，含插件注入的运行时键），用户保存
// 任一 global 配置键后插件注入的键从全部会话路径静默消失、直至重启。收敛到
// 本模块：磁盘重建 + 与启动同口径重跑 config:resolve 链。
import { loadConfigScopes, mergeConfig } from '../../core/config.js'
import { syncRegistryFromConfig } from '../../core/provider-registry.js'
import type { ServerContext } from '../types.js'

/** 按服务启动目录作用域重建 ctx.config 并同步运行时派生态。
 *  调用时机：global 作用域写入落盘成功后，或 serve 目录项目作用域写入后
 *  （两种写入都影响全部会话与服务级注册表）。落盘失败时不应调用（调用方
 *  各自的降级语义保留磁盘旧值对应的内存态）。 */
export async function rebuildServerConfig(ctx: ServerContext): Promise<void> {
  const serverScopes = loadConfigScopes(ctx.cwd)
  let config = mergeConfig(serverScopes.global, serverScopes.project)
  // 与启动同口径重跑 config:resolve 链（initPlugins:85 的同一调用形态）：
  // 插件注入的运行时键不因磁盘重建而丢失；无 handler 时 runHooks 原样返回
  // 传入 data（hooks.ts 空链语义），等价于纯磁盘重建。
  const hookResult = await ctx.hookRunner.runHooks('config:resolve', { config })
  if (hookResult !== false) config = hookResult.config
  ctx.config = config
  syncRegistryFromConfig(ctx.llmRegistry, ctx.config)
  // 权限默认模式运行时同步：设置页/底栏开关保存后立即生效（config.test.ts
  // 「PATCH permission.defaultMode=auto → ctx.permissionMode 立即生效」守护）。
  ctx.permissionMode = ctx.config.permission.defaultMode
  // 项目级注册表基于全局作用域构建，global 变更后全部失效。
  ctx.projectRegistries?.clear()
}
