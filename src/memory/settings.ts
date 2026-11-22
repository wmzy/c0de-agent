// 记忆配置解析（接线用单一出口）：config.memory → 收紧后的运行时设置。
//
// 不直接读 config.memory 的原因：DEFAULT_CONFIG 合并后理应有完整结构，但
// 手改/旧版 config.json、测试自构 Config、部分覆写（只写 memory.backend）都会
// 产生缺字段/非法值——提取/整合是后台 fire-and-forget 管线，任何一处 NaN 传播
// 都会变成静默失效。这里集中兜底 + clamp，非法值回退默认。

import type { Config, MemoryConfig } from '../shared/types/config.js'
import { resolveModelOverride } from './llm-call.js'
import { SHARPSHOOTER_MAX_FILE_LINES } from './types.js'

export interface SharpshooterSettings {
  intervalMinutes: number
  minPromptLength: number
  injectionTokenLimit: number
  maxFileLines: number
  /** 提取/整合模型覆盖；未设置回退 defaultProvider/defaultModel。 */
  model?: { provider: string; model: string }
}

export interface MemorySettings {
  backend: 'off' | 'sharpshooter'
  sharpshooter: SharpshooterSettings
}

const DEFAULTS: SharpshooterSettings = {
  intervalMinutes: 5,
  minPromptLength: 16,
  injectionTokenLimit: 15000,
  maxFileLines: SHARPSHOOTER_MAX_FILE_LINES,
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback
}

/** config.memory → 运行时设置（缺省/非法字段回退默认，backend 只认 'sharpshooter'）。 */
export function resolveMemorySettings(config: Pick<Config, 'memory'>): MemorySettings {
  const memory = config?.memory as Partial<MemoryConfig> | undefined
  const raw = memory?.sharpshooter as Partial<MemorySettings['sharpshooter']> | undefined
  const model = resolveModelOverride(raw?.model)
  return {
    backend: memory?.backend === 'sharpshooter' ? 'sharpshooter' : 'off',
    sharpshooter: {
      intervalMinutes: positiveInt(raw?.intervalMinutes, DEFAULTS.intervalMinutes),
      minPromptLength: positiveInt(raw?.minPromptLength, DEFAULTS.minPromptLength),
      injectionTokenLimit: positiveInt(raw?.injectionTokenLimit, DEFAULTS.injectionTokenLimit),
      maxFileLines: positiveInt(raw?.maxFileLines, DEFAULTS.maxFileLines),
      ...(model ? { model } : {}),
    },
  }
}
