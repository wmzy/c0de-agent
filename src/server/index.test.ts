// src/server/index.test.ts
import { describe, expect, it } from 'vitest'
import * as server from './index.js'

describe('server/index barrel export', () => {
  it('导出 createApp', () => {
    expect(typeof server.createApp).toBe('function')
  })

  it('导出 createServerContext', () => {
    expect(typeof server.createServerContext).toBe('function')
  })

  it('导出 startServer', () => {
    expect(typeof server.startServer).toBe('function')
  })

  it('导出 createAgentManager', () => {
    expect(typeof server.createAgentManager).toBe('function')
  })

  it('导出 createInteractivePermissionChecker', () => {
    expect(typeof server.createInteractivePermissionChecker).toBe('function')
  })

  it('导出 apiError 和 errorHandler', () => {
    expect(typeof server.apiError).toBe('function')
    expect(typeof server.errorHandler).toBe('function')
  })
})
