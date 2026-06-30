import type { AgentDefinition, AgentRegistry } from './types.js'

/** 创建空的 agent 注册表（内存 Map，后注册覆盖同名）。 */
function createAgentRegistry(): AgentRegistry {
  const defs = new Map<string, AgentDefinition>()

  return {
    register(def) {
      defs.set(def.name, def)
    },
    get(name) {
      return defs.get(name)
    },
    list(mode) {
      const all = Array.from(defs.values())
      if (!mode) return all
      // 'all' 模式的 agent 在任何过滤下都可见；subagent/primary 精确匹配。
      return all.filter((d) => d.mode === 'all' || d.mode === mode)
    },
    has(name) {
      return defs.has(name)
    },
  }
}

export { createAgentRegistry }
