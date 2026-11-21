// Structured file logger (single point) for node-side background diagnostics:
// best-effort catches, fire-and-forget results, and other non-user-facing output.
//
// Placement: src/core is the node-side common denominator (server/update/session/
// cli all import it) while src/web never imports core (vite alias only exposes
// @shared), so keeping node:fs here keeps it out of the web bundle. This module
// must only import node builtins — a logger that imports repo modules would
// create dependency cycles with every logging domain.

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type Logger = {
  debug: (message: string) => void
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** Resolve the log base dir. Mirrors server.ts resolveDbDir semantics locally
 *  (C0DE_DB_DIR first, relative paths resolve against cwd; else XDG_DATA_HOME/c0de;
 *  else ~/.local/share/c0de) to avoid a reverse dependency on the server module. */
function resolveLogBaseDir(): string {
  const envDir = process.env.C0DE_DB_DIR
  if (envDir && envDir.trim() !== '') return isAbsolute(envDir) ? envDir : resolve(envDir)
  const xdg = process.env.XDG_DATA_HOME
  if (xdg && xdg.trim() !== '') return join(xdg, 'c0de')
  return join(homedir(), '.local', 'share', 'c0de')
}

/** C0DE_LOG_LEVEL threshold; invalid/missing values fall back to 'info'. */
function resolveThreshold(): LogLevel {
  const raw = process.env.C0DE_LOG_LEVEL?.trim().toLowerCase()
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw
  return 'info'
}

/** Local calendar date as YYYY-MM-DD (the rotation key; deliberately not UTC). */
function localDay(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

type LogFile = { dir: string; day: string; path: string }

let threshold: LogLevel | undefined
let file: LogFile | undefined
let fileFailed = false

/** Lazily create the logs dir and pin today's file. Returns undefined on any
 *  fs failure (logging degrades to stderr-only; never throws). */
function initFile(): LogFile | undefined {
  const dir = join(resolveLogBaseDir(), 'logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    fileFailed = true
    return undefined
  }
  const day = localDay(new Date())
  return { dir, day, path: join(dir, `c0de.${day}.log`) }
}

function writeLog(level: LogLevel, namespace: string, message: string): void {
  if (threshold === undefined) threshold = resolveThreshold()
  // Level filtering applies before both the file write and the stderr echo.
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) return
  if (!fileFailed && file === undefined) file = initFile()
  const target = file
  if (target !== undefined) {
    try {
      const now = new Date()
      const day = localDay(now)
      if (day !== target.day) {
        // Natural daily rotation: check for a date flip on each write and
        // switch files (mkdir again defensively in case the dir was removed).
        target.day = day
        target.path = join(target.dir, `c0de.${day}.log`)
        mkdirSync(target.dir, { recursive: true })
      }
      appendFileSync(
        target.path,
        `${JSON.stringify({ ts: now.toISOString(), level, ns: namespace, msg: message })}\n`,
      )
    } catch {
      // Logging must never throw: file write failures are silently dropped
      // (the stderr echo below still runs for warn/error).
    }
  }
  // Echo warn/error to stderr so CLI/serve observers keep the exact same
  // visibility as the previous console.warn/console.error call sites.
  if (level === 'warn') console.warn(message)
  else if (level === 'error') console.error(message)
}

/** Get a namespaced logger (data + functions; module-scoped call sites should
 *  create one instance per file: `const logger = getLogger('core.loop')`). */
function getLogger(namespace: string): Logger {
  return {
    debug: (message: string) => writeLog('debug', namespace, message),
    info: (message: string) => writeLog('info', namespace, message),
    warn: (message: string) => writeLog('warn', namespace, message),
    error: (message: string) => writeLog('error', namespace, message),
  }
}

export type { Logger, LogLevel }
export { getLogger }
