// src/plugins/logger.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createLogger } from './logger.js'

describe('createLogger', () => {
  it('creates a logger with all 4 methods', () => {
    const logger = createLogger('test')
    expect(typeof logger.debug).toBe('function')
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.error).toBe('function')
  })

  it('logs info messages by default', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const logger = createLogger('test')
    logger.info('hello')
    expect(spy).toHaveBeenCalledWith('[test]', 'hello')
    spy.mockRestore()
  })

  it('filters out debug when level is info', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const logger = createLogger('test', 'info')
    logger.debug('hidden')
    expect(debugSpy).not.toHaveBeenCalled()
    debugSpy.mockRestore()
  })

  it('shows debug when level is debug', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const logger = createLogger('test', 'debug')
    logger.debug('visible')
    expect(debugSpy).toHaveBeenCalledWith('[test]', 'visible')
    debugSpy.mockRestore()
  })

  it('suppresses all output at silent level', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logger = createLogger('test', 'silent')
    logger.error('suppressed')
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('passes extra args to console methods', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logger = createLogger('test')
    logger.warn('warning', { key: 'val' }, 42)
    expect(spy).toHaveBeenCalledWith('[test]', 'warning', { key: 'val' }, 42)
    spy.mockRestore()
  })
})
