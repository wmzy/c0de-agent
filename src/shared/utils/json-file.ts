import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 尽力而为的 JSON 文件读写（单一实现）：serve-info 落盘、模型目录磁盘缓存、
 * 设备注册表三处此前各持一份同形副本（读：缺失/损坏 → null；写：mkdir 父目录
 * + writeFileSync），编码与容错口径已现漂移风险，收敛于此。
 *
 * 读侧失败统一 null（调用方按「无记录」回退）；写侧只收敛「mkdir + 写」形状、
 * 不吞错——错误策略是调用方语义（缓存/引导文案吞错保内存态，设备注册表如实
 * 上抛由调用方决定），由各调用点自行 try/catch。
 */

/** 读取 JSON 文件并解析；文件缺失或读取/解析失败 → null。 */
export function readJsonFileSafe<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return null
  }
}

/** 序列化并写入 JSON 文件（确保父目录存在）；pretty 时缩进 2 空格。
 *  不吞写错——见模块注释。 */
export function writeJsonFileSafe(
  path: string,
  value: unknown,
  opts: { pretty?: boolean } = {},
): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, opts.pretty ? 2 : undefined), 'utf-8')
}
