// src/plugins/logger.ts
import type { Logger, LogLevel } from './types.js'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
}

/** Create a named, level-filtered logger that writes to console. */
function createLogger(name: string, level: LogLevel = 'info'): Logger {
  const prefix = `[${name}]`
  const shouldLog = (target: LogLevel): boolean =>
    LEVEL_ORDER[level] <= LEVEL_ORDER[target]

  return {
    debug: (msg: string, ...args: unknown[]) => {
      if (shouldLog('debug')) console.debug(prefix, msg, ...args)
    },
    info: (msg: string, ...args: unknown[]) => {
      if (shouldLog('info')) console.info(prefix, msg, ...args)
    },
    warn: (msg: string, ...args: unknown[]) => {
      if (shouldLog('warn')) console.warn(prefix, msg, ...args)
    },
    error: (msg: string, ...args: unknown[]) => {
      if (shouldLog('error')) console.error(prefix, msg, ...args)
    },
  }
}

export { createLogger }
