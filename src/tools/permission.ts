import { randomUUID } from 'node:crypto'
import type { ToolContext, ToolDef } from '../shared/types/tool.js'
import type { PermissionChecker, PermissionResult } from './types.js'

/** Permission checker configuration. */
type PermissionConfig = {
  /** Tool names that are always allowed, regardless of their declared permission. */
  alwaysAllow?: string[]
  /** Tool names that are always denied, regardless of their declared permission. */
  alwaysDeny?: string[]
}

function checkPermission(tool: ToolDef, _input: unknown): PermissionResult {
  switch (tool.permission) {
    case 'auto':
      return { _tag: 'allow' }
    case 'deny':
      return { _tag: 'deny', reason: `Tool "${tool.name}" is disabled` }
    case 'ask':
      return {
        _tag: 'ask',
        reason: `Tool "${tool.name}" requires confirmation`,
        toolCallId: randomUUID(),
      }
  }
}

/** Default checker: allows auto, asks for ask, denies deny. No persistent state. */
export const autoAllowChecker: PermissionChecker = {
  check: async (_tool: ToolDef, _input: unknown, _ctx: ToolContext): Promise<PermissionResult> => {
    return checkPermission(_tool, _input)
  },
  confirm: (_toolCallId: string, _approved: boolean) => {},
}

/** Create a permission checker with configurable allow/deny lists. */
export function createPermissionChecker(config: PermissionConfig): PermissionChecker {
  const allowSet = new Set(config.alwaysAllow ?? [])
  const denySet = new Set(config.alwaysDeny ?? [])

  return {
    check: async (tool: ToolDef, _input: unknown, _ctx: ToolContext): Promise<PermissionResult> => {
      if (denySet.has(tool.name)) {
        return { _tag: 'deny', reason: `Tool "${tool.name}" is disabled by configuration` }
      }
      if (allowSet.has(tool.name)) {
        return { _tag: 'allow' }
      }
      return checkPermission(tool, _input)
    },
    confirm: (_toolCallId: string, _approved: boolean) => {},
  }
}
