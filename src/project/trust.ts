// src/project/trust.ts
// P0-2 项目信任边界：评估「项目作用域原始配置」中的风险项。
//
// 背景：`git clone` 一个携带 `.c0de/config.json`（或 `.c0de/plugins`）的仓库后
// `c0de serve`，此前配置静默合并生效（可把权限降级为 auto/YOLO），插件在启动时
// 直接加载执行——信任在克隆完成时被默认授予。现在：
//  - 聊天入口：未信任项目 + 风险配置 → 409 TRUST_REQUIRED（前端弹窗确认后
//    POST /api/projects/:id/trust 落盘 trustedAt，一次性）；
//  - 启动入口：未信任项目的 .c0de/plugins 不加载（信任后重启生效）。
//
// 仅评估「项目作用域原始配置」（loadConfigScopes(cwd).project），绝不评估
// 合并结果/全局配置——全局配置是用户在本机自己的显式编辑，天然可信。
import type { Config } from '../shared/types/config.js'

/** 单个风险项：kind 供前端图标/文案映射，detail 为人类可读说明。 */
export type TrustRiskItem = {
  kind: 'permission-auto' | 'permission-timeout-deny' | 'plugins-enabled'
  detail: string
}

/**
 * 汇总项目作用域原始配置中的风险项。无风险返回空数组。
 * 宽松形状：项目 JSON 可能字段漂移，非法值一律忽略（fail-closed 由
 * 「未信任 + 无风险项 = 不拦截」与「有风险项必拦截」共同保证——解析不出
 * 风险的配置也不含可信风险）。
 */
export function summarizeProjectRisk(raw: Partial<Config> | undefined): TrustRiskItem[] {
  const items: TrustRiskItem[] = []
  if (!raw) return items

  if (raw.permission?.defaultMode === 'auto') {
    items.push({
      kind: 'permission-auto',
      detail: '权限模式 auto：bash/write/edit 等需要确认的工具将被自动放行',
    })
  }

  // 权限确认超时后的动作降级为 'deny'：安全默认是 'pause'（超时后暂停对话，
  // 防 agent 在用户缺席时继续自主执行）；'deny' 会「拒绝该工具但继续自动执行」。
  // 携带此键的可疑仓库可在不触发 auto 权限的前提下悄然弱化超时安全网。
  if (raw.permission?.timeoutAction === 'deny') {
    items.push({
      kind: 'permission-timeout-deny',
      detail:
        '权限超时动作 timeoutAction=deny：确认超时后 agent 将继续自主执行（安全默认应为 pause）',
    })
  }

  const plugins = raw.plugins?.enabled
  if (Array.isArray(plugins)) {
    const names = plugins.filter((p): p is string => typeof p === 'string')
    if (names.length > 0) {
      items.push({ kind: 'plugins-enabled', detail: `启用项目插件：${names.join('、')}` })
    }
  }

  return items
}
