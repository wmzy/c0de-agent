// LSP 服务器定义解析与二进制定位（纯 fs，无进程 IO）。
// 内置默认表按名可被 config.lsp.servers 浅合并覆盖（未提供字段继承内置值，
// disabled=true 剔除）；resolveBinary 先查 workspaceRoot 的 node_modules/.bin
// 再逐个 PATH 目录（项目本地安装的语言服务器优先于全局）。

import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import type { LspServerUserConfig } from '../shared/types/config.js'
import type { LspServerDef } from './types.js'
import { extensionOf } from './types.js'

/** 内置默认表（条目顺序即 resolveServers 输出顺序，自定义条目按名追加其后）。 */
const BUILTIN_LSP_SERVERS: Record<string, Omit<LspServerDef, 'name'>> = {
  'typescript-language-server': {
    command: 'typescript-language-server',
    args: ['--stdio'],
    fileTypes: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
    rootMarkers: ['package.json', 'tsconfig.json'],
  },
  pyright: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    fileTypes: ['py'],
    rootMarkers: ['pyproject.toml', 'requirements.txt', 'setup.py', '.git'],
  },
  gopls: {
    command: 'gopls',
    args: [],
    fileTypes: ['go'],
    rootMarkers: ['go.mod', '.git'],
  },
  clangd: {
    command: 'clangd',
    args: [],
    fileTypes: ['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh'],
    rootMarkers: ['compile_commands.json', '.clangd', 'CMakeLists.txt', '.git'],
  },
  'rust-analyzer': {
    command: 'rust-analyzer',
    args: [],
    fileTypes: ['rs'],
    rootMarkers: ['Cargo.toml', '.git'],
  },
}

/**
 * 合并内置默认表与 config.lsp.servers：内置条目按名浅合并（undefined 字段
 * 继承）；disabled=true 剔除；自定义条目（内置表之外）要求显式 command，
 * 否则跳过——没有 command 无法 spawn，静默注册只会浪费一次工具调用。
 */
function resolveServers(config: {
  lsp: { servers: Record<string, LspServerUserConfig> }
}): LspServerDef[] {
  const user = config.lsp?.servers ?? {}
  const out: LspServerDef[] = []
  for (const [name, builtin] of Object.entries(BUILTIN_LSP_SERVERS)) {
    const override = user[name]
    if (override?.disabled) continue
    const merged: LspServerDef = {
      name,
      command: override?.command ?? builtin.command,
      args: override?.args ?? builtin.args,
      fileTypes: override?.fileTypes ?? builtin.fileTypes,
      rootMarkers: override?.rootMarkers ?? builtin.rootMarkers,
      ...(override?.initOptions ? { initOptions: override.initOptions } : {}),
      ...(override?.settings ? { settings: override.settings } : {}),
    }
    out.push(merged)
  }
  for (const name of Object.keys(user).sort()) {
    if (name in BUILTIN_LSP_SERVERS) continue
    const custom = user[name]
    if (!custom || custom.disabled || !custom.command) continue
    out.push({
      name,
      command: custom.command,
      args: custom.args ?? [],
      fileTypes: custom.fileTypes ?? [],
      rootMarkers: custom.rootMarkers ?? ['.git'],
      ...(custom.initOptions ? { initOptions: custom.initOptions } : {}),
      ...(custom.settings ? { settings: custom.settings } : {}),
    })
  }
  return out
}

/** 按扩展名匹配的服务器列表（fileTypes 覆盖该扩展名的全部服务器）。 */
function pickServersForFile(servers: LspServerDef[], absPath: string): LspServerDef[] {
  const ext = extensionOf(absPath)
  if (!ext) return []
  return servers.filter((s) => s.fileTypes.includes(ext))
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 定位服务器二进制：含路径分隔符的 command 直接判定；否则先
 * `<rootDir>/node_modules/.bin/<command>`（项目本地安装优先），再按 PATH
 * 逐目录找可执行文件。返回绝对路径或 null（由调用方给出安装指引）。
 */
function resolveBinary(command: string, rootDir: string): string | null {
  if (command.includes('/') || isAbsolute(command)) {
    const p = resolve(command)
    return isExecutable(p) ? p : null
  }
  const local = join(rootDir, 'node_modules', '.bin', command)
  if (isExecutable(local)) return local
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, command)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/**
 * 从 fromDir 逐级向上找首个含任一 marker 的目录作为 workspaceRoot；
 * 到文件系统根未命中返回 fromDir 本身（语言服务器以 cwd 兜底也能工作）。
 */
function findWorkspaceRoot(fromDir: string, markers: string[]): string {
  let dir = resolve(fromDir)
  for (;;) {
    if (markers.some((m) => existsSync(join(dir, m)))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(fromDir)
    dir = parent
  }
}

export { BUILTIN_LSP_SERVERS, findWorkspaceRoot, pickServersForFile, resolveBinary, resolveServers }
