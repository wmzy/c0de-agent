// conflict:// URL resolver（内部 URL scheme，见 ../resolver.ts 的 registry 框架）。
//
// 核心扫描/注册/splice 算法都在 ./conflict.ts；本文件只做 scheme 装配：
//   - resolve：渲染已注册的 `conflict://<N>`（可加 /ours /theirs /base 单侧
//     视图），读前复检磁盘防陈旧视图
//   - write：委托 resolveConflict 完成「读原文件 → 展开 @side 简写 → 按记录
//     区间 splice → 写回 → 重扫更新注册表」
// registry 装配（把本工厂产物注册进默认 registry）由宿主完成，本文件不改
// resolvers.ts。
import type { URLResolver } from '../../shared/types/tool.js'
import {
  displayPath,
  type ParsedConflictUri,
  parseConflictUri,
  renderConflictRegion,
  requireConflictEntry,
  resolveConflict,
} from './conflict.js'

/** 解析 conflict:// 目标；非 conflict URL 是装配错误，直接抛。 */
function parseTarget(raw: string): ParsedConflictUri {
  const parsed = parseConflictUri(raw)
  if (!parsed) {
    throw new Error(
      `Invalid conflict URI '${raw}': must be 'conflict://<N>', 'conflict://<N>/<scope>', or 'conflict://*'.`,
    )
  }
  return parsed
}

/**
 * conflict:// 解析器工厂。无重依赖（注册表按 session id 模块级存储，见
 * ./conflict.ts），每次调用返回独立实例；scheme 注册先到先得（见
 * ../resolver.ts）。
 */
function createConflictResolver(): URLResolver {
  return {
    scheme: 'conflict',
    resolve: async (url, ctx) => {
      const target = parseTarget(url)
      if (target.id === '*') {
        throw new Error(
          "Reading 'conflict://*' is not supported — wildcards are write-only. Read 'conflict://<N>' to inspect a single block.",
        )
      }
      // 读前复检：磁盘变了先重定位/退役，模型不会拿到陈旧视图
      const entry = await requireConflictEntry(ctx.session.id, target.id)
      const region = renderConflictRegion(entry, target.scope)
      const last = region.startLine + region.lines.length - 1
      const range =
        region.startLine === last ? `L${region.startLine}` : `L${region.startLine}-L${last}`
      const side = target.scope ? ` (${target.scope})` : ''
      const header = `#${entry.id} ${displayPath(entry.absolutePath, ctx.cwd)} ${range}${side}`
      return [header, ...region.lines].join('\n')
    },
    write: async (url, content, ctx) => {
      const target = parseTarget(url)
      if (target.scope) {
        throw new Error(
          `Conflict URI scope '/${target.scope}' is read-only — read 'conflict://${target.id}/${target.scope}' to inspect that side. ` +
            `To write, drop the scope ('conflict://${target.id}') and put the chosen content (or shorthand like '@${target.scope}') in content.`,
        )
      }
      return resolveConflict(target.id, content, { cwd: ctx.cwd, sessionId: ctx.session.id })
    },
  }
}

export { createConflictResolver }
